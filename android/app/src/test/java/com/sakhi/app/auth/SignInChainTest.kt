package com.sakhi.app.auth

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The order of the ways in: Truecaller, then Google's number picker, then typing the number. */
class SignInChainTest {
    private val steps = mutableListOf<String>()
    private fun chain(truecaller: Boolean) = SignInChain(
        CoroutineScope(Dispatchers.Unconfined),
        truecallerReady = { truecaller },
        startTruecaller = { steps += "truecaller" },
        startNumberPicker = { steps += "picker" },
        typeNumber = { steps += "type" },
    )

    @Test fun `Truecaller first, then the number picker, then typing`() {
        val c = chain(truecaller = true)
        c.begin()
        assertEquals(listOf("truecaller"), steps)
        assertTrue(c.running)
        c.truecallerFailed()
        assertEquals(listOf("truecaller", "picker"), steps)
        c.pickerFailed()
        assertEquals(listOf("truecaller", "picker", "type"), steps)
        assertFalse(c.running)
    }

    @Test fun `no Truecaller goes straight to the number picker`() {
        val c = chain(truecaller = false)
        c.begin()
        assertEquals(listOf("picker"), steps)
    }

    @Test fun `it runs once, signing in or choosing a number ends it, and reset starts over`() {
        val c = chain(truecaller = true)
        c.begin(); c.begin()
        assertEquals(listOf("truecaller"), steps)
        c.finished()
        c.truecallerFailed(); c.pickerFailed()
        assertEquals("nothing more after it finished", listOf("truecaller"), steps)
        c.reset(); c.begin()
        assertEquals(listOf("truecaller", "truecaller"), steps)
    }

    @Test fun `a late picker failure doesn't jump back`() {
        val c = chain(truecaller = true)
        c.begin()
        c.pickerFailed()
        assertEquals("the picker wasn't open yet", listOf("truecaller"), steps)
    }
}
