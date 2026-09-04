package com.ghostmesh.app.radio

import android.Manifest
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.BluetoothDevice
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.UUID

/**
 * GhostMeshRadio — the peripheral half of the BitChat dual-role radio.
 *
 * Why this exists: react-native-ble-plx (3.5.1) is central-only — it has no
 * advertiser and no GATT server. Without those a phone cannot be discovered or
 * written to, so the mesh cannot form. This module supplies exactly the two
 * missing pieces, on the official BitChat UUIDs and with no advertised device
 * name (privacy, per WHITEPAPER §4):
 *
 *   startServer(service, characteristic)  → GATT server accepting writes
 *   startAdvertising(service)             → BLE advertiser, connectable
 *   notifyPeers(base64)                   → push a frame to connected centrals
 *   stopServer()                          → tear both down
 *
 * Inbound writes are emitted to JS as `GhostMeshWrite {value: base64, peer}`;
 * disconnects as `GhostMeshPeerGone {peer}`. All framing, fragmentation,
 * reassembly, signing and encryption stay in TypeScript (src/protocol/*) — this
 * file only moves opaque bytes.
 */
class GhostMeshRadioModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var gattServer: BluetoothGattServer? = null
  private var meshCharacteristic: BluetoothGattCharacteristic? = null
  private var advertiser: android.bluetooth.le.BluetoothLeAdvertiser? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private val connected = mutableSetOf<BluetoothDevice>()

  override fun getName(): String = "GhostMeshRadio"

  private fun btManager(): BluetoothManager? =
    reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private fun granted(permission: String): Boolean =
    reactContext.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun emit(event: String, params: WritableMap) {
    try {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(event, params)
    } catch (ignored: Exception) {
      // JS side not ready (or being torn down) — dropping a frame is fine,
      // the mesh retransmits and the peer will re-announce.
    }
  }

  private fun emitError(message: String) {
    emit("GhostMeshError", Arguments.createMap().apply { putString("message", message) })
  }

  /** Synchronous so the JS adapter can decide its capabilities at construction. */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun isAvailable(): Boolean {
    val hasLe = reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
    val adapter = try {
      btManager()?.adapter
    } catch (ignored: SecurityException) {
      null
    }
    return hasLe && adapter != null
  }

  private val gattCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        connected.add(device)
      } else {
        connected.remove(device)
        emit(
          "GhostMeshPeerGone",
          Arguments.createMap().apply { putString("peer", device.address) }
        )
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?
    ) {
      val bytes = value
      if (bytes != null && bytes.isNotEmpty()) {
        emit(
          "GhostMeshWrite",
          Arguments.createMap().apply {
            putString("value", Base64.encodeToString(bytes, Base64.NO_WRAP))
            putString("peer", device.address)
          }
        )
      }
      if (responseNeeded) {
        try {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
        } catch (ignored: SecurityException) {
        }
      }
    }
  }

  @ReactMethod
  fun startServer(serviceUuid: String, charUuid: String, promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !granted(Manifest.permission.BLUETOOTH_CONNECT)) {
        promise.reject("E_PERM", "BLUETOOTH_CONNECT not granted")
        return
      }
      val manager = btManager()
      if (manager == null) {
        promise.reject("E_NO_BT", "no bluetooth manager on this device")
        return
      }
      val server = manager.openGattServer(reactContext, gattCallback)
      if (server == null) {
        promise.reject("E_GATT", "could not open GATT server (another app may hold it)")
        return
      }
      val service = BluetoothGattService(
        UUID.fromString(serviceUuid),
        BluetoothGattService.SERVICE_TYPE_PRIMARY
      )
      val characteristic = BluetoothGattCharacteristic(
        UUID.fromString(charUuid),
        BluetoothGattCharacteristic.PROPERTY_WRITE or
          BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
          BluetoothGattCharacteristic.PROPERTY_NOTIFY,
        BluetoothGattCharacteristic.PERMISSION_WRITE
      )
      service.addCharacteristic(characteristic)
      server.addService(service)
      gattServer = server
      meshCharacteristic = characteristic
      promise.resolve(true)
    } catch (e: SecurityException) {
      promise.reject("E_PERM", e.message ?: "bluetooth permission denied", e)
    } catch (e: Exception) {
      promise.reject("E_SERVER", e.message ?: "startServer failed", e)
    }
  }

  @ReactMethod
  fun startAdvertising(serviceUuid: String, promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !granted(Manifest.permission.BLUETOOTH_ADVERTISE)) {
        promise.reject("E_PERM", "BLUETOOTH_ADVERTISE not granted")
        return
      }
      val adapter = btManager()?.adapter
      val adv = adapter?.bluetoothLeAdvertiser
      if (adv == null) {
        promise.reject("E_ADV", "this device cannot advertise BLE")
        return
      }
      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
        .setConnectable(true)
        .setTimeout(0)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .build()
      val data = AdvertiseData.Builder()
        // Privacy: service UUID only, never a local name (WHITEPAPER §4).
        .setIncludeDeviceName(false)
        .setIncludeTxPowerLevel(false)
        .addServiceUuid(ParcelUuid(UUID.fromString(serviceUuid)))
        .build()
      val callback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {}
        override fun onStartFailure(errorCode: Int) {
          emitError("advertising failed with code $errorCode")
        }
      }
      adv.startAdvertising(settings, data, callback)
      advertiser = adv
      advertiseCallback = callback
      promise.resolve(true)
    } catch (e: SecurityException) {
      promise.reject("E_PERM", e.message ?: "advertising permission denied", e)
    } catch (e: Exception) {
      promise.reject("E_ADV", e.message ?: "startAdvertising failed", e)
    }
  }

  /** Push one opaque frame to every connected central. Returns how many got it. */
  @ReactMethod
  fun notifyPeers(base64Frame: String, promise: Promise) {
    try {
      val server = gattServer
      val characteristic = meshCharacteristic
      if (server == null || characteristic == null) {
        promise.reject("E_NO_SERVER", "GATT server not started")
        return
      }
      val bytes = Base64.decode(base64Frame, Base64.NO_WRAP)
      var delivered = 0
      for (device in connected.toList()) {
        try {
          @Suppress("DEPRECATION")
          characteristic.value = bytes
          val sent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicValue(device, characteristic, false)
          } else {
            @Suppress("DEPRECATION")
            server.notifyCharacteristicChanged(device, characteristic, false)
          }
          if (sent) delivered++
        } catch (ignored: Exception) {
          // one unreachable peer must not block the rest
        }
      }
      promise.resolve(delivered)
    } catch (e: Exception) {
      promise.reject("E_NOTIFY", e.message ?: "notify failed", e)
    }
  }

  @ReactMethod
  fun stopServer(promise: Promise) {
    try {
      advertiseCallback?.let { cb -> advertiser?.stopAdvertising(cb) }
      advertiseCallback = null
      advertiser = null
      gattServer?.close()
      gattServer = null
      meshCharacteristic = null
      connected.clear()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_STOP", e.message ?: "stopServer failed", e)
    }
  }

  /** Required by NativeEventEmitter on Android. */
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}
