package com.sakhi.app.ui

import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Keeps a chat list pinned to its newest message.
 *
 * Scrolling once when a message is added is not enough: a lazy list holds on to its *first* visible item, so
 * anything that happens after that one scroll pushes the newest message below the fold. That covers a bubble
 * that grows (animateContentSize, a live transcript, "Checking your English…", a corrections card), a reply
 * that replaces the "thinking" dots without changing the item count, the keyboard or the task card shrinking
 * the list, and an animated scroll cut short by the next change.
 *
 * So instead the list follows the bottom for as long as the learner hasn't scrolled away: whenever there is
 * more below and nobody is scrolling, it scrolls to the very end. Dragging up stops following; scrolling back
 * to the bottom, or a new message ([newest] changes), starts it again.
 */
@Composable
fun FollowNewest(list: LazyListState, newest: Any?) {
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(newest) { follow = true }
    LaunchedEffect(list) {
        launch { list.interactionSource.interactions.collect { if (it is DragInteraction.Start) follow = false } }
        launch { snapshotFlow { !list.isScrollInProgress && !list.canScrollForward }.collect { if (it) follow = true } }
        while (true) {
            snapshotFlow { follow && list.canScrollForward && !list.isScrollInProgress }.first { it }
            val moved = try { list.scrollTowardEnd() } catch (e: CancellationException) {
                ensureActive() // a drag (or another scroll) took over the list: carry on following
                true
            }
            if (!moved) withFrameNanos { } // nothing to do this frame: wait for the next layout
        }
    }
}

/** How far the end of the last item is past the bottom of the list, or null when it isn't laid out at all. */
internal fun LazyListLayoutInfo.overhang(): Int? {
    val last = visibleItemsInfo.lastOrNull() ?: return null
    if (last.index < totalItemsCount - 1) return null
    return last.offset + last.size - (viewportEndOffset - afterContentPadding)
}

/** One step toward the end of the list; false when there was nothing to scroll. */
private suspend fun LazyListState.scrollTowardEnd(): Boolean {
    val info = layoutInfo
    if (info.totalItemsCount == 0) return false
    val gap = info.overhang()
    return when {
        gap == null -> { animateScrollToItem(info.totalItemsCount - 1); true }
        gap > 0 -> { animateScrollBy(gap.toFloat()); true }
        else -> false
    }
}
