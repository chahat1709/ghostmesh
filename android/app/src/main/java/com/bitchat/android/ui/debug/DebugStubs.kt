package com.bitchat.android.ui.debug

import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Minimal local stand-ins for the debug-settings layer of the upstream app.
 * The imported mesh files reference these only inside guarded fallbacks;
 * every switch defaults to the upstream ON behavior.
 */
data class DebugScanResult(
    val deviceName: String?,
    val deviceAddress: String,
    val rssi: Int,
    val peerID: String?
)

object DebugPreferenceManager {
    fun getBleEnabled(default: Boolean): Boolean = default
}

class DebugSettingsManager private constructor() {
    val bleEnabled = MutableStateFlow(true)
    val gattServerEnabled = MutableStateFlow(true)
    val gattClientEnabled = MutableStateFlow(true)
    val maxConnectionsOverall = MutableStateFlow(8)
    val maxClientConnections = MutableStateFlow(8)

    fun addScanResult(result: DebugScanResult) = Unit

    companion object {
        @Volatile
        private var INSTANCE: DebugSettingsManager? = null

        fun getInstance(): DebugSettingsManager =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: DebugSettingsManager().also { INSTANCE = it }
            }
    }
}
