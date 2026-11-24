package com.sakhi.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The chat list keeps the newest message in view through everything that used to leave it below the fold. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatScrollTest {
    @get:Rule val compose = createComposeRule()

    private data class Row(val key: String, val height: Int)

    private val rows = mutableStateListOf<Row>()
    private val listHeight = mutableStateOf(300)
    private lateinit var list: LazyListState

    private fun show(vararg initial: Row) {
        rows.addAll(initial)
        compose.setContent {
            list = rememberLazyListState()
            FollowNewest(list, rows.lastOrNull()?.key)
            Column {
                LazyColumn(Modifier.fillMaxWidth().height(listHeight.value.dp).testTag("chat"), state = list) {
                    items(rows, key = { it.key }) { Box(Modifier.fillMaxWidth().height(it.height.dp)) }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun atBottom() = !list.canScrollForward && list.layoutInfo.overhang().let { it != null && it <= 0 }

    private fun history() = Array(10) { Row("m$it", 80) }

    @Test fun newMessageScrollsIntoView() {
        show(*history())
        assertTrue(atBottom())
        rows.add(Row("new", 120)); compose.waitForIdle()
        assertTrue(atBottom())
    }

    @Test fun lastMessageGrowingAfterItAppearsStaysInView() {
        // A live transcript, "Checking your English…", or a corrections card: same item, taller.
        show(*history())
        rows[rows.lastIndex] = rows.last().copy(height = 260); compose.waitForIdle()
        assertTrue(atBottom())
    }

    @Test fun replyReplacingTheThinkingDotsWithTheSameCountScrolls() {
        // Learn chat: items + the dots row, then the reply in place of the dots. The count doesn't change.
        show(*history(), Row("thinking", 40))
        rows[rows.lastIndex] = Row("reply", 240); compose.waitForIdle()
        assertTrue(atBottom())
    }

    @Test fun listGettingShorterKeepsTheNewestInView() {
        // The keyboard opening, or the task card sliding in under the conversation.
        show(*history())
        listHeight.value = 150; compose.waitForIdle()
        assertTrue(atBottom())
    }

    @Test fun readerScrollingUpIsLeftAloneUntilANewMessage() {
        show(*history())
        compose.onNodeWithTag("chat").performTouchInput { swipeDown() }
        compose.waitForIdle()
        assertTrue(list.canScrollForward)
        val readingAt = list.firstVisibleItemIndex
        rows[rows.lastIndex] = rows.last().copy(height = 200); compose.waitForIdle()
        assertEquals(readingAt, list.firstVisibleItemIndex) // growth below doesn't yank the reader down
        rows.add(Row("new", 80)); compose.waitForIdle()
        assertTrue(atBottom()) // but a new message does
    }
}
