package com.starkllm.app.ui

/** One block of an answer: the model writes Markdown (the PC's chat shows it formatted too). */
sealed interface Block {
    data class Heading(val level: Int, val text: String) : Block
    data class Paragraph(val text: String) : Block
    data class Item(val marker: String, val text: String, val depth: Int) : Block
    data class Code(val text: String) : Block
    data class Quote(val text: String) : Block
    data object Rule : Block
}

private val HEADING = Regex("""^(#{1,6})\s+(.*)$""")
private val BULLET = Regex("""^(\s*)[-*•+]\s+(.*)$""")
private val NUMBERED = Regex("""^(\s*)(\d{1,3})[.)]\s+(.*)$""")
private val RULE = Regex("""^\s*([-*_])(\s*\1){2,}\s*$""")

/** Splits Markdown into blocks; unfinished text (while the answer streams in) is fine. */
fun parseMarkdown(text: String): List<Block> {
    val out = mutableListOf<Block>()
    val paragraph = StringBuilder()
    fun flush() {
        if (paragraph.isNotBlank()) out += Block.Paragraph(paragraph.toString().trim())
        paragraph.clear()
    }
    val lines = text.replace("\r\n", "\n").split('\n')
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        when {
            line.trimStart().startsWith("```") -> {
                flush()
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.append(lines[i]).append('\n')
                    i++
                }
                out += Block.Code(code.toString().trimEnd())
            }
            line.isBlank() -> flush()
            RULE.matches(line) -> { flush(); out += Block.Rule }
            HEADING.matches(line) -> {
                flush()
                val m = HEADING.find(line)!!
                out += Block.Heading(m.groupValues[1].length, m.groupValues[2].trim().trimEnd('#').trim())
            }
            BULLET.matches(line) -> {
                flush()
                val m = BULLET.find(line)!!
                out += Block.Item("•", m.groupValues[2], m.groupValues[1].length / 2)
            }
            NUMBERED.matches(line) -> {
                flush()
                val m = NUMBERED.find(line)!!
                out += Block.Item("${m.groupValues[2]}.", m.groupValues[3], m.groupValues[1].length / 2)
            }
            line.trimStart().startsWith(">") -> { flush(); out += Block.Quote(line.trimStart().removePrefix(">").trim()) }
            else -> paragraph.append(if (paragraph.isEmpty()) line.trim() else " " + line.trim())
        }
        i++
    }
    flush()
    return out
}

