package com.starkllm.app.data

/**
 * How urgent a deadline is, from the state the PC gave it (deadlines_service.py: overdue, today, soon = within a week,
 * upcoming). The phone never counts days itself: its clock or time zone could differ from the PC's.
 */
enum class Urgency { OVERDUE, THIS_WEEK, LATER, DONE }

fun urgencyOf(d: Deadline): Urgency = when {
    d.done -> Urgency.DONE
    d.state == "overdue" -> Urgency.OVERDUE
    d.state == "today" || d.state == "soon" -> Urgency.THIS_WEEK
    else -> Urgency.LATER
}

/**
 * A new document on the home card: "sender · kind · amount" as the PC read them from the letter. The amount is the one
 * the letter asks for, or else the amount of one of its deadlines. The file name only when the PC found neither sender
 * nor kind (a photo, a note, a letter not read yet). [kind] is the kind already in the app's language, or null.
 */
fun documentSummary(doc: RecentDocument, kind: String?, deadlines: List<Deadline>): String {
    val amount = doc.askedAmount?.trim()?.takeIf { it.isNotEmpty() }
        ?: deadlines.firstOrNull { d ->
            d.filename == doc.filename && !d.amount.isNullOrBlank() &&
                (doc.workspaceId == null || d.workspaceId == null || d.workspaceId == doc.workspaceId)
        }?.amount?.trim()
    val sender = doc.sender?.trim()?.takeIf { it.isNotEmpty() }
    if (sender == null && kind == null) return listOfNotNull(doc.filename.ifBlank { null }, amount).joinToString(" · ")
    return listOfNotNull(sender, kind, amount).joinToString(" · ")
}

/** The kinds of letters the PC knows (facts_service.py TYPES), as in the desktop app's inbox (Inbox.jsx TYPE_LABEL) */
val LETTER_KINDS = listOf(
    "debt_collection", "reminder", "fine", "tax_notice", "payslip", "termination", "statement", "invoice", "job_offer",
    "contract", "invitation", "medical", "price_change", "payment_notice", "notice", "insurance", "prize", "message",
)
