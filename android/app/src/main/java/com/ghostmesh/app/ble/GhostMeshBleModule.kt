package com.ghostmesh.app.ble

import android.bluetooth.BluetoothDevice
import android.util.Base64
import android.util.Log
import com.bitchat.android.mesh.BluetoothConnectionManagerDelegate
import com.bitchat.android.mesh.BluetoothConnectionTracker
import com.bitchat.android.mesh.BluetoothGattClientManager
import com.bitchat.android.mesh.BluetoothGattServerManager
import com.bitchat.android.mesh.BluetoothPacketBroadcaster
import com.bitchat.android.mesh.BluetoothPermissionManager
import com.bitchat.android.mesh.PowerManager
import com.bitchat.android.model.RoutedPacket
import com.bitchat.android.protocol.BitchatPacket
import com.bitchat.android.services.AppStateStore
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Hosts the imported bitchat link layer (GATT server + client managers,
 * broadcaster, tracker) and bridges it to JS. Packet relay/routing decisions
 * stay in the TS MeshEngine; this layer moves frames across real Bluetooth.
 */
class GhostMeshBleModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    private const val TAG = "GhostMeshBle"
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private var tracker: BluetoothConnectionTracker? = null
  private var permission: BluetoothPermissionManager? = null
  private var power: PowerManager? = null
  private var server: BluetoothGattServerManager? = null
  private var client: BluetoothGattClientManager? = null
  private var broadcaster: BluetoothPacketBroadcaster? = null

  private val directPeers = mutableSetOf<String>()
  private val directPeersLock = Any()

  private val delegate = object : BluetoothConnectionManagerDelegate {
    override fun onPacketReceived(
      packet: BitchatPacket,
      peerID: String,
      device: BluetoothDevice?,
      ingressLinkID: String
    ) {
      val bytes = try {
        packet.toBinaryData(padding = false) ?: return
      } catch (e: Exception) {
        return
      }
      val p = Arguments.createMap()
      p.putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
      p.putString("peerID", peerID)
      p.putString("address", device?.address ?: "")
      p.putString("linkID", ingressLinkID)
      emit("GhostMeshBleFrame", p)
    }

    override fun onDeviceConnected(device: BluetoothDevice) {
      trackPeer(device.address, true)
      val p = Arguments.createMap()
      p.putString("address", device.address)
      p.putBoolean("connected", true)
      p.putInt("count", tracker?.getConnectedDeviceCount() ?: 0)
      emit("GhostMeshBlePeers", p)
    }

    override fun onDeviceDisconnected(device: BluetoothDevice, linkID: String?, peerID: String?) {
      trackPeer(device.address, false)
      val p = Arguments.createMap()
      p.putString("address", device.address)
      p.putBoolean("connected", false)
      p.putInt("count", tracker?.getConnectedDeviceCount() ?: 0)
      emit("GhostMeshBlePeers", p)
    }

    override fun onRSSIUpdated(deviceAddress: String, rssi: Int) {
      val p = Arguments.createMap()
      p.putString("address", deviceAddress)
      p.putInt("rssi", rssi)
      emit("GhostMeshBleRssi", p)
    }
  }

  private fun trackPeer(address: String, connected: Boolean) {
    synchronized(directPeersLock) {
      if (connected) directPeers.add(address) else directPeers.remove(address)
      try {
        AppStateStore.setDirectPeers(directPeers.toSet())
      } catch (e: Exception) {
        Log.w(TAG, "directPeers update: ${e.message}")
      }
    }
  }

  override fun getName(): String = "GhostMeshBle"

  private fun emit(event: String, params: Any?) {
    if (!ctx.hasActiveReactInstance()) return
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(event, params)
    } catch (e: Exception) {
      Log.w(TAG, "emit $event: ${e.message}")
    }
  }

  /** Build the imported stack (needs our peer ID for scan-response) and start both roles. */
  @ReactMethod
  fun startAdvertising(peerIdHex: String, promise: Promise) {
    try {
      stopStack()
      val appCtx = ctx.applicationContext
      val pm = BluetoothPermissionManager(appCtx)
      if (!pm.hasBluetoothPermissions()) {
        promise.resolve(false)
        return
      }
      val pw = PowerManager.getInstance(appCtx)
      val tr = BluetoothConnectionTracker(scope, pw)
      val sv = BluetoothGattServerManager(appCtx, scope, tr, pm, pw, delegate, peerIdHex)
      val cl = BluetoothGattClientManager(appCtx, scope, tr, pm, pw, delegate)
      tracker = tr
      permission = pm
      power = pw
      server = sv
      client = cl
      broadcaster = BluetoothPacketBroadcaster(scope, tr, null, peerIdHex)
      val s = sv.start()
      val c = cl.start()
      Log.i(TAG, "stack started server=$s client=$c")
      promise.resolve(s || c)
    } catch (e: Exception) {
      Log.e(TAG, "start: ${e.message}")
      promise.reject("ble_start", e.message, e)
    }
  }

  /** Decode one base64 frame with their codec and flood it across all links. */
  @ReactMethod
  fun broadcastFrame(base64: String, promise: Promise) {
    try {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      val packet = BitchatPacket.fromBinaryData(bytes)
      if (packet == null) {
        promise.resolve(false)
        return
      }
      val ok = broadcaster?.broadcastPacket(
        RoutedPacket(packet),
        server?.getGattServer(),
        server?.getCharacteristic()
      ) ?: false
      promise.resolve(ok)
    } catch (e: Exception) {
      promise.reject("ble_broadcast", e.message, e)
    }
  }

  @ReactMethod
  fun sendToPeer(peerIdHex: String, base64: String, promise: Promise) {
    try {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      val packet = BitchatPacket.fromBinaryData(bytes)
      if (packet == null) {
        promise.resolve(false)
        return
      }
      val ok = broadcaster?.sendPacketToPeer(
        RoutedPacket(packet),
        peerIdHex,
        server?.getGattServer(),
        server?.getCharacteristic()
      ) ?: false
      promise.resolve(ok)
    } catch (e: Exception) {
      promise.reject("ble_send", e.message, e)
    }
  }

  @ReactMethod
  fun linkCount(promise: Promise) {
    try {
      promise.resolve(tracker?.getConnectedDeviceCount() ?: 0)
    } catch (e: Exception) {
      promise.resolve(0)
    }
  }

  @ReactMethod
  fun stopAdvertising(promise: Promise) {
    try {
      stopStack()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ble_stop", e.message, e)
    }
  }

  private fun stopStack() {
    try {
      server?.stop()
    } catch (e: Exception) { /* ignore */ }
    try {
      client?.stop()
    } catch (e: Exception) { /* ignore */ }
    try {
      tracker?.stop()
    } catch (e: Exception) { /* ignore */ }
    server = null
    client = null
    broadcaster = null
    tracker = null
    permission = null
    synchronized(directPeersLock) {
      directPeers.clear()
      try {
        AppStateStore.setDirectPeers(emptySet())
      } catch (e: Exception) { /* ignore */ }
    }
  }

  override fun onCatalystInstanceDestroy() {
    stopStack()
    super.onCatalystInstanceDestroy()
  }
}
