package com.bitchat.android.mesh

import android.bluetooth.BluetoothDevice
import com.bitchat.android.protocol.BitchatPacket

/**
 * Delegate interface for Bluetooth connection manager callbacks.
 * Verbatim from the upstream BluetoothConnectionManager.kt — declared here so
 * the imported link layer compiles without the rest of the upstream app.
 */
interface BluetoothConnectionManagerDelegate {
    fun onPacketReceived(
        packet: BitchatPacket,
        peerID: String,
        device: BluetoothDevice?,
        ingressLinkID: String
    )
    fun onDeviceConnected(device: BluetoothDevice)
    fun onDeviceDisconnected(device: BluetoothDevice, linkID: String?, peerID: String?)
    fun onRSSIUpdated(deviceAddress: String, rssi: Int)
    fun onGattClientWriteComplete(deviceAddress: String, linkID: String, status: Int) = Unit
    fun onGattServerNotificationComplete(deviceAddress: String, linkID: String?, status: Int) = Unit
}
