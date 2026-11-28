package com.starkllm.app.screens

import com.starkllm.app.Answered
import com.starkllm.app.Screen
import com.starkllm.app.UiState
import com.starkllm.app.data.ChatLine
import com.starkllm.app.data.Deadline
import com.starkllm.app.data.Hello
import com.starkllm.app.data.Home
import com.starkllm.app.data.Link
import com.starkllm.app.data.QueuedQuestion
import com.starkllm.app.data.RecentDocument
import com.starkllm.app.data.Workspace

/** Made-up letters and questions for the screens' tests and screenshots: no real person, PC or document */
object Demo {
    val link = Link("Demo-PC", listOf("192.168.0.10"), 8443, "demo-fingerprint", "demo-device", "demo-token")
    val workspace = Workspace(1, "Briefe")

    val deadlines = listOf(
        Deadline("a", "2026-11-20", kind = "payment", amount = "52,40 EUR", sender = "Stadtwerke Musterstadt", filename = "Stadtwerke-Rechnung.pdf",
            text = "Bitte überweisen Sie die Nachzahlung von 52,40 Euro bis zum 20.11.2026.", days = -8, state = "overdue", workspaceId = 1),
        Deadline("b", "2026-11-28", sender = "Hausverwaltung Berger", filename = "Ablesung.pdf",
            text = "Die Zählerablesung findet am 28.11.2026 zwischen 8 und 12 Uhr statt.", days = 0, state = "today", workspaceId = 1),
        Deadline("c", "2026-12-01", kind = "payment", amount = "1.240,00 EUR", sender = "Finanzamt Musterstadt", filename = "Steuerbescheid-2025.pdf",
            text = "Die Nachzahlung von 1.240,00 Euro ist bis zum 01.12.2026 fällig.", days = 3, state = "soon", workspaceId = 1),
        Deadline("d", "2027-01-15", kind = "payment", amount = "89,90 EUR", sender = "Kurpfalz Direkt Versicherung AG", filename = "Beitragsrechnung.pdf",
            text = "Der Jahresbeitrag von 89,90 Euro wird am 15.01.2027 abgebucht.", days = 48, state = "upcoming", workspaceId = 1),
    )

    val home = Home(
        today = "2026-11-28",
        recent = listOf(
            RecentDocument(1, "Stadtwerke-Rechnung.pdf", "Briefe", 1, sender = "Stadtwerke Musterstadt", letterKind = "invoice"),
            RecentDocument(2, "Steuerbescheid-2025.pdf", "Briefe", 1, sender = "Finanzamt Musterstadt", letterKind = "tax_notice", askedAmount = "1.240,00 EUR"),
            RecentDocument(3, "IMG_4711.jpg", "Briefe", 1),
        ),
    )

    val queue = listOf(
        QueuedQuestion("q1", link.id, 1, "Briefe", text = "Bis wann muss ich die Nachzahlung an die Stadtwerke überweisen?", askedAt = 1),
        QueuedQuestion("q2", link.id, 1, "Briefe", chatId = 7, text = "Welche Unterlagen fehlen dem Finanzamt noch?", askedAt = 2),
    )

    fun state(
        level: String = "work",
        queue: List<QueuedQuestion> = emptyList(),
        answered: List<Answered> = emptyList(),
        online: Boolean = true,
    ) = UiState(
        screen = Screen.Home,
        links = listOf(link),
        link = link,
        hello = if (online) Hello(pcName = "Demo-PC", version = "2.6.1", signedIn = true, level = level) else null,
        workspaces = listOf(workspace, Workspace(2, "Versicherungen")),
        workspaceId = 1,
        home = home,
        inboxCount = 2,
        deadlines = deadlines,
        queue = queue,
        answered = answered,
    )

    val chat = Screen.Chat(workspace, 7, "Steuerbescheid 2025", Screen.Home, nonce = 1)
    val chatLines = listOf(
        ChatLine("user", "Was steht im Steuerbescheid?"),
        ChatLine("assistant", "Der Bescheid für 2025 setzt eine **Nachzahlung von 1.240,00 Euro** fest, fällig am 01.12.2026."),
    )
}
