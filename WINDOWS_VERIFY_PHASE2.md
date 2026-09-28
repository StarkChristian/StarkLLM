# Windows Manual Verification Checklist — Phase 2 (Local MCP Host)

This runbook provides 4 step-by-step manual checks to verify Phase 2 local Model Context Protocol (MCP) host capabilities on Windows.

---

### Prerequisites
1. Start StarkLLM on Windows:
   ```powershell
   .\start.exe
   ```
2. Log in at `http://localhost:5173`.
3. Open **Settings &rarr; MCP Host** tab and verify:
   - **Enable Local MCP Host** is ON.
   - All 3 read-only tools are checked: `list_workspace_files`, `search_local_kb`, `fetch_cited_chunk`.
   - Server status displays `StarkLLM Builtin (In-Process)` &bull; `CONNECTED (READ-ONLY)`.

---

### Check 1: List files in current workspace via confirmed tool call
**Goal:** Verify the model requests `list_workspace_files`, user sees editable arguments, confirms execution, and receives workspace file list.

1. Create or open a workspace that has 1 or 2 uploaded documents (e.g. `sample.pdf`).
2. In the chat input, type:
   > "Please use the list_workspace_files tool to show all documents in my workspace."
3. **Verify in UI:**
   - The assistant emits a tool call block.
   - An **MCP Tool Call** card appears for `list_workspace_files`.
   - Arguments are visible in an editable box (e.g. `{"workspace_id": 1}`).
   - Click **"Confirm & Run"**.
4. **Expected Result:**
   - Status transitions to `Executed`.
   - The result box displays JSON with `total_files`, filenames, file sizes, and creation dates.
   - Click **"Send Result to Assistant"** to see the assistant summarize the list in chat.

---

### Check 2: Search KB & confirm locator in the result
**Goal:** Verify `search_local_kb` queries the local Knowledge Base and returns results carrying canonical citation locators (`Page N`, `Section`, `Chunk N`).

1. Ensure at least one Knowledge Base folder is registered and indexed.
2. In the chat input, type:
   > "Use search_local_kb to find any mention of privacy in my Knowledge Base."
3. **Verify in UI:**
   - The **MCP Tool Call** card appears with tool name `search_local_kb` and argument `{"query": "privacy"}`.
   - (Optional) Edit the query string in the text box to test parameter editing.
   - Click **"Confirm & Run"**.
4. **Expected Result:**
   - Status updates to `Executed`.
   - Result contains matching snippets along with canonical `locator` field (e.g. `Page 1`, `Chunk 2`) and formatted `label`.

---

### Check 3: Reject / cancel a tool call; chat continues
**Goal:** Verify cancelling a tool call does not crash the session and leaves chat history intact.

1. In chat, prompt the model to call a tool:
   > "Check what files are in my workspace using list_workspace_files."
2. When the **MCP Tool Call** card appears in `pending` state, click **"Cancel"**.
3. **Expected Result:**
   - The card badge turns grey with status `Cancelled`.
   - The message remains intact in chat history.
   - You can immediately type another regular prompt (e.g. "Tell me a joke") and continue chatting without errors or page refresh.

---

### Check 4: Broken JSON from model does not kill the stream
**Goal:** Verify malformed tool JSON produces an inline error chip without killing the stream or crashing React.

1. Simulate or prompt the assistant with a malformed tool block:
   ```text
   ```tool_call
   {broken json: "missing quotes, incomplete syntax
   ```
   ```
2. **Expected Result:**
   - ChatArea catches the parse failure gracefully.
   - Renders inline Error Chip: `⚠️ Malformed Tool Call JSON from model`.
   - No unhandled exceptions in the browser console.
   - Chat input bar remains enabled and responsive for subsequent messages.

---

### Summary of Guarantees Verified
- **100% Local / Zero-Cloud**: In-process execution with no third-party HTTP egress.
- **Human-in-the-loop**: Model cannot execute tools silently; every call requires UI confirmation.
- **Editable Parameters**: Full user transparency and control over tool arguments.
- **Stream Resilience**: No stream disconnects or crashes on invalid tool payloads.
