package com.ghostmesh.app.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Peripheral role: advertises the BitChat service UUID (no device name, like
 * the iOS app) and hosts the GATT characteristic that centrals write frames
 * to and subscribe for notifications on.
 */
@SuppressLint("MissingPermission")
class GhostPeripheral(private val context: Context) {

  interface Listener {
    fun onWrite(bytes: ByteArray, address: String)
    fun onSubscribersChanged(count: Int)
    fun onBtState(on: Boolean)
    fun onError(message: String)
  }

  var listener: Listener? = null

  private val btManager: BluetoothManager =
    context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private var advertiser: BluetoothLeAdvertiser? = null
  private var gattServer: BluetoothGattServer? = null
  private var characteristic: BluetoothGattCharacteristic? = null

  private val subscribed = ConcurrentHashMap.newKeySet<BluetoothDevice>()
  private val mtuByDevice = ConcurrentHashMap<BluetoothDevice, Int>()

  private var advertising = false

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
      advertising = true
    }
    override fun onStartFailure(errorCode: Int) {
      advertising = false
      listener?.onError("advertise failed: $errorCode")
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothGatt.STATE_DISCONNECTED) {
        subscribed.remove(device)
        mtuByDevice.remove(device)
        listener?.onSubscribersChanged(subscribed.size)
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      mtuByDevice[device] = mtu
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice, requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean, responseNeeded: Boolean,
      offset: Int, value: ByteArray
    ) {
      if (descriptor.uuid == GhostBleUuids.CCCD) {
        val enable = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ||
          value.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
        if (enable) subscribed.add(device) else subscribed.remove(device)
        listener?.onSubscribersChanged(subscribed.size)
      }
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice, requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean, responseNeeded: Boolean,
      offset: Int, value: ByteArray
    ) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      }
      if (value.isNotEmpty()) {
        listener?.onWrite(value.copyOf(), device.address)
      }
    }
  }

  fun bluetoothOn(): Boolean =
    try {
      btManager.adapter?.isEnabled == true
    } catch (e: Exception) {
      false
    }

  fun start(serviceUuid: String, charUuid: String): Boolean {
    stop()
    val adapter = btManager.adapter ?: run {
      listener?.onError("no bluetooth adapter")
      return false
    }
    if (!adapter.isEnabled) {
      listener?.onBtState(false)
      return false
    }
    try {
      gattServer = btManager.openGattServer(context, serverCallback)
      val service = BluetoothGattService(
        UUID.fromString(serviceUuid), BluetoothGattService.SERVICE_TYPE_PRIMARY
      )
      val char = BluetoothGattCharacteristic(
        UUID.fromString(charUuid),
        BluetoothGattCharacteristic.PROPERTY_WRITE or
          BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
          BluetoothGattCharacteristic.PROPERTY_NOTIFY,
        BluetoothGattCharacteristic.PERMISSION_WRITE
      )
      val cccd = BluetoothGattDescriptor(
        GhostBleUuids.CCCD,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
      )
      char.addDescriptor(cccd)
      service.addCharacteristic(char)
      gattServer?.addService(service)
      characteristic = char

      advertiser = adapter.bluetoothLeAdvertiser
      if (advertiser == null) {
        listener?.onError("advertising not supported")
        return false
      }
      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
        .setConnectable(true)
        .setTimeout(0)
        .build()
      val data = AdvertiseData.Builder()
        .setIncludeDeviceName(false) // privacy: service UUID only, like bitchat
        .addServiceUuid(ParcelUuid(UUID.fromString(serviceUuid)))
        .build()
      advertiser?.startAdvertising(settings, data, advertiseCallback)
      listener?.onBtState(true)
      return true
    } catch (e: Exception) {
      listener?.onError("peripheral start: ${e.message}")
      stop()
      return false
    }
  }

  /** Notify all subscribed centrals, chunked to each link's MTU. Returns receivers. */
  fun notifyFrame(base64: String): Int {
    val bytes = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (e: Exception) {
      return 0
    }
    val char = characteristic ?: return 0
    val server = gattServer ?: return 0
    var n = 0
    for (device in subscribed.toList()) {
      val payload = (mtuByDevice[device] ?: 23) - 3
      var off = 0
      var ok = true
      while (off < bytes.size) {
        val end = minOf(off + payload, bytes.size)
        val chunk = bytes.copyOfRange(off, end)
        try {
          val sent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicChanged(device, char, false, chunk) == BluetoothGatt.GATT_SUCCESS
          } else {
            @Suppress("DEPRECATION")
            char.value = chunk
            @Suppress("DEPRECATION")
            server.notifyCharacteristicChanged(device, char, false)
          }
          if (!sent) {
            ok = false
            break
          }
        } catch (e: Exception) {
          ok = false
          break
        }
        off = end
      }
      if (ok) n++
    }
    return n
  }

  fun subscriberCount(): Int = subscribed.size

  fun stop() {
    try {
      if (advertising) advertiser?.stopAdvertising(advertiseCallback)
    } catch (e: Exception) { /* ignore */ }
    advertising = false
    try {
      gattServer?.close()
    } catch (e: Exception) { /* ignore */ }
    gattServer = null
    characteristic = null
    subscribed.clear()
    mtuByDevice.clear()
  }
}

object GhostBleUuids {
  val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
}
