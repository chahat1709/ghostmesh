package com.ghostmesh.app.ble

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/** React Native bridge for the peripheral role. Central role lives in JS (ble-plx). */
class GhostMeshBleModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  private val peripheral = GhostPeripheral(ctx.applicationContext)

  init {
    peripheral.listener = object : GhostPeripheral.Listener {
      override fun onWrite(bytes: ByteArray, address: String) {
        val p = Arguments.createMap()
        p.putString("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        p.putString("address", address)
        emit("GhostMeshBleWrite", p)
      }
      override fun onSubscribersChanged(count: Int) {
        val p = Arguments.createMap()
        p.putInt("count", count)
        emit("GhostMeshBlePeers", p)
      }
      override fun onBtState(on: Boolean) {
        val p = Arguments.createMap()
        p.putBoolean("on", on)
        emit("GhostMeshBleState", p)
      }
      override fun onError(message: String) {
        val p = Arguments.createMap()
        p.putString("message", message)
        emit("GhostMeshBleError", p)
      }
    }
  }

  override fun getName(): String = "GhostMeshBle"

  private fun emit(event: String, params: Any?) {
    if (!ctx.hasActiveReactInstance()) return
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, params)
  }

  @ReactMethod
  fun startAdvertising(serviceUuid: String, charUuid: String, promise: Promise) {
    try {
      promise.resolve(peripheral.start(serviceUuid, charUuid))
    } catch (e: Exception) {
      promise.reject("ble_start", e.message, e)
    }
  }

  @ReactMethod
  fun stopAdvertising(promise: Promise) {
    try {
      peripheral.stop()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ble_stop", e.message, e)
    }
  }

  /** Fan one base64 frame out to all subscribed centrals. Resolves receivers. */
  @ReactMethod
  fun notifyFrame(base64: String, promise: Promise) {
    try {
      promise.resolve(peripheral.notifyFrame(base64))
    } catch (e: Exception) {
      promise.reject("ble_notify", e.message, e)
    }
  }

  @ReactMethod
  fun subscriberCount(promise: Promise) {
    promise.resolve(peripheral.subscriberCount())
  }

  @ReactMethod
  fun isBluetoothOn(promise: Promise) {
    promise.resolve(peripheral.bluetoothOn())
  }

  override fun onCatalystInstanceDestroy() {
    peripheral.stop()
    super.onCatalystInstanceDestroy()
  }
}
