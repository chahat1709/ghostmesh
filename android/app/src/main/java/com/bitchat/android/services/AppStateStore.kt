package com.bitchat.android.services

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Minimal stand-in for the upstream AppStateStore. The imported mesh stack
 * only consumes [directPeers] (drives power profiles); the bridge keeps it
 * updated on connect/disconnect.
 */
object AppStateStore {
    private val _directPeers = MutableStateFlow<Set<String>>(emptySet())
    val directPeers: StateFlow<Set<String>> = _directPeers.asStateFlow()

    fun setDirectPeers(peers: Set<String>) {
        _directPeers.value = peers
    }
}
