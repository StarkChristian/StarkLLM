package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type OllamaTagsResponse struct {
	Models []struct {
		Name  string `json:"name"`
		Model string `json:"model"`
	} `json:"models"`
}

type PreflightReport struct {
	Timestamp       string   `json:"timestamp"`
	WorkingDir      string   `json:"working_dir"`
	OS              string   `json:"os"`
	DockerRunning   bool     `json:"docker_running"`
	DockerKernel    string   `json:"docker_kernel"`
	OllamaReachable bool     `json:"ollama_reachable"`
	OllamaModels    []string `json:"ollama_models"`
	HasChatModel    bool     `json:"has_chat_model"`
	HasEmbedModel   bool     `json:"has_embed_model"`
	Port8000Free    bool     `json:"port_8000_free"`
	Port5173Free    bool     `json:"port_5173_free"`
	Errors          []string `json:"errors"`
	Warnings        []string `json:"warnings"`
}

func main() {
	fmt.Println("==================================================")
	fmt.Println("             StarkLLM Windows Launcher            ")
	fmt.Println("          Windows Research Beta — Phase 1         ")
	fmt.Println("==================================================")
	fmt.Println()

	exePath, err := os.Executable()
	if err != nil {
		fmt.Printf("[ERROR] Unable to determine launcher location: %v\n", err)
		pauseAndExit(1)
	}
	exeDir := filepath.Dir(exePath)
	_ = os.Chdir(exeDir)

	launcherToken := initLauncherToken(exeDir)

	isPreflightOnly := false
	addFolderArg := false
	var folderPathArg string
	for i := 0; i < len(os.Args[1:]); i++ {
		arg := os.Args[1+i]
		if arg == "--preflight" || arg == "-check" || arg == "--check" || arg == "/check" {
			isPreflightOnly = true
		}
		if arg == "--add-folder" || arg == "-add-folder" || arg == "-a" || arg == "add-folder" {
			addFolderArg = true
		}
		if (arg == "--folder" || arg == "-folder") && 1+i+1 < len(os.Args) {
			folderPathArg = os.Args[1+i+1]
			addFolderArg = true
			i++
		}
		if strings.HasPrefix(arg, "--folder=") {
			folderPathArg = strings.TrimPrefix(arg, "--folder=")
			addFolderArg = true
		}
	}

	report := PreflightReport{
		Timestamp:  time.Now().Format("2006-01-02 15:04:05 MST"),
		WorkingDir: exeDir,
		OS:         fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
		Errors:     []string{},
		Warnings:   []string{},
	}

	// 1. Verify workspace files
	if _, err := os.Stat("docker-compose.yml"); os.IsNotExist(err) {
		msg := fmt.Sprintf("docker-compose.yml not found in current directory: %s", exeDir)
		report.Errors = append(report.Errors, msg)
		fmt.Println("[ERROR] docker-compose.yml not found in current directory:")
		fmt.Printf("        %s\n", exeDir)
		fmt.Println("Please make sure all extracted files are in the same folder.")
		writePreflightReport(report)
		pauseAndExit(1)
	}

	// 2. Check Docker Desktop & WSL2
	fmt.Println("[1/5] Checking Docker Desktop & WSL2 status...")
	dockerInfoOut, dockerErr := exec.Command("docker", "info").CombinedOutput()
	if dockerErr != nil {
		msg := "Docker Desktop is not running or not responsive."
		report.Errors = append(report.Errors, msg)
		fmt.Println()
		fmt.Println("[ERROR] Docker Desktop is not running or not responsive.")
		fmt.Println("        Remediation steps:")
		fmt.Println("        1. Open Docker Desktop from the Start Menu.")
		fmt.Println("        2. Wait until the whale icon in the Windows taskbar is steady.")
		fmt.Println("        3. Ensure WSL2 integration is enabled (Docker Settings -> General).")
		fmt.Println("        Download Docker: https://www.docker.com/products/docker-desktop/")
		fmt.Println()
		writePreflightReport(report)
		pauseAndExit(1)
	}
	report.DockerRunning = true
	// Parse kernel/WSL2 info from docker info
	dockerInfoStr := string(dockerInfoOut)
	for _, line := range strings.Split(dockerInfoStr, "\n") {
		if strings.Contains(line, "Kernel Version:") {
			report.DockerKernel = strings.TrimSpace(strings.TrimPrefix(line, " Kernel Version:"))
			break
		}
	}
	fmt.Printf("  -> Docker is running (Kernel: %s).\n", report.DockerKernel)

	// 3. Clean previous containers first to release local ports
	fmt.Println("[2/5] Cleaning previous StarkLLM containers...")
	_ = exec.Command("docker", "rm", "-f", "starkllm-backend", "starkllm-frontend").Run()
	_ = exec.Command("docker", "compose", "down", "--remove-orphans").Run()
	fmt.Println("  -> Container cleanup complete.")

	// 4. Check Port Availability (8000 and 5173)
	fmt.Println("[3/5] Verifying local network ports (8000, 5173)...")
	port8000Free := isPortAvailable(8000)
	port5173Free := isPortAvailable(5173)
	report.Port8000Free = port8000Free
	report.Port5173Free = port5173Free

	if !port8000Free {
		msg := "Port 8000 is occupied by another application. StarkLLM Backend cannot bind."
		report.Errors = append(report.Errors, msg)
		fmt.Println()
		fmt.Println("[ERROR] Port 8000 is already in use by another application on your system.")
		fmt.Println("        Please close the process using port 8000, or change BACKEND_PORT in .env.")
		writePreflightReport(report)
		pauseAndExit(1)
	}
	if !port5173Free {
		msg := "Port 5173 is occupied by another application. StarkLLM Frontend cannot bind."
		report.Errors = append(report.Errors, msg)
		fmt.Println()
		fmt.Println("[ERROR] Port 5173 is already in use by another application on your system.")
		fmt.Println("        Please close the process using port 5173, or change FRONTEND_PORT in .env.")
		writePreflightReport(report)
		pauseAndExit(1)
	}
	fmt.Println("  -> Ports 8000 (Backend) and 5173 (Frontend) are available.")

	// 5. Check Ollama local service & models
	fmt.Println("[4/5] Checking Ollama service and configured models...")
	configuredTextModel, configuredEmbedModel := loadConfiguredModels()
	fmt.Printf("  -> Configured models: chat='%s', embed='%s'\n", configuredTextModel, configuredEmbedModel)

	ollamaTags, ollamaErr := queryOllamaTags()
	if ollamaErr != nil {
		report.OllamaReachable = false
		msg := "Ollama service is not running or unreachable on http://localhost:11434"
		report.Errors = append(report.Errors, msg)
		fmt.Println()
		fmt.Println("[ERROR] Ollama is not running or unreachable on http://localhost:11434.")
		fmt.Println("        StarkLLM requires Ollama for local LLM inference and embeddings.")
		fmt.Println("        1. Download and start Ollama from https://ollama.com")
		fmt.Println("        2. Pull the configured models:")
		fmt.Printf("             ollama pull %s\n", configuredTextModel)
		fmt.Printf("             ollama pull %s\n", configuredEmbedModel)
		fmt.Println()
		writePreflightReport(report)
		pauseAndExit(1)
	}

	report.OllamaReachable = true
	var missingModels []string
	for _, m := range ollamaTags.Models {
		report.OllamaModels = append(report.OllamaModels, m.Name)
		if modelMatches(m.Name, configuredTextModel) {
			report.HasChatModel = true
		}
		if modelMatches(m.Name, configuredEmbedModel) {
			report.HasEmbedModel = true
		}
	}
	fmt.Printf("  -> Ollama detected with %d model(s) installed.\n", len(report.OllamaModels))

	if !report.HasChatModel {
		missingModels = append(missingModels, configuredTextModel)
		report.Errors = append(report.Errors, fmt.Sprintf("Configured chat model '%s' is missing in Ollama", configuredTextModel))
	}
	if !report.HasEmbedModel {
		missingModels = append(missingModels, configuredEmbedModel)
		report.Errors = append(report.Errors, fmt.Sprintf("Configured embedding model '%s' is missing in Ollama", configuredEmbedModel))
	}

	if len(missingModels) > 0 {
		fmt.Println()
		fmt.Println("[ERROR] Required Ollama model(s) are missing!")
		fmt.Println("        StarkLLM requires the configured models from .env before starting.")
		fmt.Println("        Please open a terminal and run:")
		for _, m := range missingModels {
			fmt.Printf("          ollama pull %s\n", m)
		}
		fmt.Println()
		writePreflightReport(report)
		pauseAndExit(1)
	}
	fmt.Println("  -> Both required models are verified in Ollama.")

	// Write preflight report to disk for diagnostics
	writePreflightReport(report)

	if isPreflightOnly {
		fmt.Println()
		fmt.Println("==================================================")
		fmt.Println(" Preflight diagnostics complete!")
		fmt.Println(" Report written to: preflight_report.txt")
		fmt.Println("==================================================")
		if len(report.Errors) > 0 {
			os.Exit(1)
		}
		os.Exit(0)
	}

	// 6. Start Docker Compose
	fmt.Println()
	fmt.Println("[5/5] Building and launching StarkLLM containers...")
	composeCmd := exec.Command("docker", "compose", "up", "--build", "-d")
	composeCmd.Stdout = os.Stdout
	composeCmd.Stderr = os.Stderr
	if err := composeCmd.Run(); err != nil {
		fmt.Println()
		fmt.Printf("[ERROR] Failed to start Docker containers: %v\n", err)
		fmt.Println("See 'preflight_report.txt' in this directory for diagnostic details.")
		pauseAndExit(1)
	}

	// 7. Health Polling
	fmt.Println()
	fmt.Println("Waiting for backend API to become ready (http://localhost:8000/health)...")
	fmt.Println("(First launch can take 1-2 minutes while Python environment initializes)")
	fmt.Println()

	backendReady := waitForBackend("http://localhost:8000/health", 90)
	if backendReady {
		fmt.Println("  -> Backend is healthy and ready!")
	} else {
		fmt.Println("  [WARNING] Backend health poll timed out after 90 seconds.")
		fmt.Println("            The container may still be initializing. Opening browser anyway...")
	}

	fmt.Println()
	fmt.Println("Launching StarkLLM Desktop Application Window...")
	launchDesktopWindow(exeDir, "http://localhost:5173")

	// 8. Knowledge Base sync resume and folder picker (Windows only)
	if backendReady && runtime.GOOS == "windows" {
		mappings := loadKBMappings(exeDir)
		if len(mappings) > 0 {
			fmt.Printf("  Resuming background sync for %d mapped folder(s)...\n", len(mappings))
			resumeKBMirrors(mappings)
		}
		if addFolderArg {
			handleKBFolderPicker(exeDir, launcherToken, folderPathArg)
		}
	}

	fmt.Println()
	fmt.Println("==================================================")
	fmt.Println(" StarkLLM is running at http://localhost:5173")
	fmt.Println(" Diagnostic report saved: preflight_report.txt")
	fmt.Println("==================================================")
	fmt.Println()
	fmt.Println("Commands:")
	fmt.Println("  [A] Add a Windows folder to Knowledge Base")
	fmt.Println("  [Enter] Exit launcher (containers continue running)")
	fmt.Println()

	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("Enter command [A / Enter to exit]: ")
		if !scanner.Scan() {
			break
		}
		cmd := strings.TrimSpace(strings.ToLower(scanner.Text()))
		if cmd == "a" || cmd == "add" {
			handleKBFolderPicker(exeDir, launcherToken, "")
			fmt.Println()
			continue
		}
		break
	}
	os.Exit(0)
}

func isPortAvailable(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func loadConfiguredModels() (string, string) {
	textModel := "qwen3.8:27b"
	embedModel := "qwen3-embedding:0.6b"

	file, err := os.Open(".env")
	if err != nil {
		return textModel, embedModel
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		if idx := strings.Index(val, "#"); idx != -1 {
			val = strings.TrimSpace(val[:idx])
		}
		val = strings.Trim(val, "\"'")

		if key == "DEFAULT_TEXT_MODEL" && val != "" {
			textModel = val
		} else if key == "DEFAULT_EMBEDDING_MODEL" && val != "" {
			embedModel = val
		}
	}
	return textModel, embedModel
}

func modelMatches(actualName, targetName string) bool {
	act := strings.ToLower(strings.TrimSpace(actualName))
	tgt := strings.ToLower(strings.TrimSpace(targetName))
	if act == tgt || act == tgt+":latest" {
		return true
	}
	if strings.HasPrefix(act, tgt+":") {
		return true
	}
	return false
}

func queryOllamaTags() (*OllamaTagsResponse, error) {
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://localhost:11434/api/tags")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama returned status %d", resp.StatusCode)
	}

	var tags OllamaTagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tags); err != nil {
		return nil, err
	}
	return &tags, nil
}

func waitForBackend(url string, maxSeconds int) bool {
	client := http.Client{Timeout: 2 * time.Second}
	for i := 1; i <= maxSeconds; i++ {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return true
			}
		}
		if i%5 == 0 || i <= 5 {
			fmt.Printf("  Waiting for backend... [%d/%d]\n", i, maxSeconds)
		}
		time.Sleep(1 * time.Second)
	}
	return false
}

func writePreflightReport(r PreflightReport) {
	lines := []string{
		"==================================================",
		"          StarkLLM Preflight Diagnostic Report     ",
		"==================================================",
		fmt.Sprintf("Timestamp:       %s", r.Timestamp),
		fmt.Sprintf("Working Dir:     %s", r.WorkingDir),
		fmt.Sprintf("OS / Platform:   %s", r.OS),
		fmt.Sprintf("Docker Running:  %t", r.DockerRunning),
		fmt.Sprintf("Docker Kernel:   %s", r.DockerKernel),
		fmt.Sprintf("Ollama Reachable:%t", r.OllamaReachable),
		fmt.Sprintf("Port 8000 Free:  %t", r.Port8000Free),
		fmt.Sprintf("Port 5173 Free:  %t", r.Port5173Free),
		"",
		"Ollama Detected Models:",
	}
	if len(r.OllamaModels) == 0 {
		lines = append(lines, "  (None detected or Ollama unreachable)")
	} else {
		for _, m := range r.OllamaModels {
			lines = append(lines, fmt.Sprintf("  - %s", m))
		}
	}
	lines = append(lines, "")
	if len(r.Errors) > 0 {
		lines = append(lines, "Errors:")
		for _, e := range r.Errors {
			lines = append(lines, fmt.Sprintf("  [!] %s", e))
		}
		lines = append(lines, "")
	}
	if len(r.Warnings) > 0 {
		lines = append(lines, "Warnings:")
		for _, w := range r.Warnings {
			lines = append(lines, fmt.Sprintf("  [*] %s", w))
		}
		lines = append(lines, "")
	}
	lines = append(lines, "==================================================")
	content := strings.Join(lines, "\r\n")
	_ = os.WriteFile("preflight_report.txt", []byte(content), 0644)
}

func launchDesktopWindow(exeDir, url string) {
	if runtime.GOOS == "windows" {
		// 1. Check unpacked Electron native desktop application
		electronApp := filepath.Join(exeDir, "desktop", "dist", "win-unpacked", "StarkLLM.exe")
		if _, err := os.Stat(electronApp); err == nil {
			cmd := exec.Command(electronApp)
			_ = cmd.Start()
			return
		}

		// 2. Check bundled standalone executable in root
		rootApp := filepath.Join(exeDir, "StarkLLM.exe")
		if _, err := os.Stat(rootApp); err == nil {
			cmd := exec.Command(rootApp)
			_ = cmd.Start()
			return
		}

		// 3. Native App Window via Edge (Frameless standalone application window)
		edgePath := `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
		if _, err := os.Stat(edgePath); err == nil {
			appData := os.Getenv("LOCALAPPDATA")
			userProfile := filepath.Join(appData, "StarkLLM", "AppProfile")
			cmd := exec.Command(edgePath, "--app="+url, "--window-size=1440,900", "--user-data-dir="+userProfile)
			_ = cmd.Start()
			return
		}

		// 4. Default browser fallback
		cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
		_ = cmd.Start()
		return
	}

	if runtime.GOOS == "darwin" {
		cmd := exec.Command("open", url)
		_ = cmd.Start()
	} else {
		cmd := exec.Command("xdg-open", url)
		_ = cmd.Start()
	}
}

func pauseAndExit(code int) {
	fmt.Println()
	fmt.Println("Press Enter to exit...")
	reader := bufio.NewReader(os.Stdin)
	_, _ = reader.ReadString('\n')
	os.Exit(code)
}

// ---------------------------------------------------------------------------
// Phase 1.5B — KB folder picker, safe one-way copy, mappings persistence
// ---------------------------------------------------------------------------

// KBMapping represents a mapped Windows folder persisted in kb_mappings.json.
type KBMapping struct {
	SourcePath    string `json:"source_path"`
	Slug          string `json:"slug"`
	DestPath      string `json:"dest_path"`
	ContainerPath string `json:"container_path"`
	FolderName    string `json:"folder_name"`
	CreatedAt     string `json:"created_at"`
}

// initLauncherToken retrieves or generates a secure launcher token stored in data/.launcher_token.
// Does not rotate if a valid token file already exists, preserving tokens across concurrent/subsequent invocations.
func initLauncherToken(exeDir string) string {
	tokenPath := filepath.Join(exeDir, "data", ".launcher_token")
	if data, err := os.ReadFile(tokenPath); err == nil {
		tok := strings.TrimSpace(string(data))
		if len(tok) >= 16 {
			return tok
		}
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("starkllm_%d", time.Now().UnixNano())
	}
	token := hex.EncodeToString(b)
	_ = os.MkdirAll(filepath.Dir(tokenPath), 0755)
	_ = os.WriteFile(tokenPath, []byte(token), 0600)
	if runtime.GOOS == "windows" {
		username := os.Getenv("USERNAME")
		if username != "" {
			_ = exec.Command("icacls", tokenPath, "/inheritance:r", "/grant:r", username+":(R,W)").Run()
		}
	}
	return token
}

// loadKBMappings loads saved folder mappings from kb_mappings.json.
func loadKBMappings(exeDir string) []KBMapping {
	p := filepath.Join(exeDir, "kb_mappings.json")
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var mappings []KBMapping
	_ = json.Unmarshal(data, &mappings)
	return mappings
}

// saveKBMapping writes or updates a folder mapping in kb_mappings.json.
func saveKBMapping(exeDir string, mapping KBMapping) {
	p := filepath.Join(exeDir, "kb_mappings.json")
	mappings := loadKBMappings(exeDir)
	for i, m := range mappings {
		if m.Slug == mapping.Slug || m.SourcePath == mapping.SourcePath {
			mappings[i] = mapping
			data, _ := json.MarshalIndent(mappings, "", "  ")
			_ = os.WriteFile(p, data, 0644)
			return
		}
	}
	mappings = append(mappings, mapping)
	data, _ := json.MarshalIndent(mappings, "", "  ")
	_ = os.WriteFile(p, data, 0644)
}

// resumeKBMirrors silently restarts background synchronization for existing mappings.
func resumeKBMirrors(mappings []KBMapping) {
	for _, m := range mappings {
		if _, err := os.Stat(m.SourcePath); err == nil {
			_ = startRobocopyBackground(m.SourcePath, m.DestPath)
		}
	}
}

// runInitialCopy performs a synchronous one-way copy from src to dst.
// robocopy exit codes < 8 indicate success (0 = no changes, 1 = files copied, etc.).
func runInitialCopy(src, dst string) error {
	cmd := exec.Command("robocopy", src, dst, "/E", "/R:2", "/W:5", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
	err := cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() < 8 {
				return nil
			}
		}
		return err
	}
	return nil
}

// startRobocopyBackground starts continuous one-way synchronization in the background.
// Note: We use /E and never /MIR or /PURGE. Raw user files are never deleted or modified.
func startRobocopyBackground(src, dst string) error {
	cmd := exec.Command("robocopy", src, dst, "/E", "/R:2", "/W:5", "/MON:1", "/MOT:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
	if runtime.GOOS == "windows" {
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	}
	return cmd.Start()
}

// handleKBFolderPicker runs the Windows folder picker, initial copy pass,
// background watcher, and registers the mirrored folder with the backend.
func handleKBFolderPicker(exeDir, token, explicitPath string) {
	var winPath string
	var err error
	if explicitPath != "" {
		winPath = explicitPath
	} else if envPath := os.Getenv("STARKLLM_PICK_FOLDER"); envPath != "" {
		winPath = envPath
	} else {
		fmt.Println()
		fmt.Println("  Opening Windows folder picker…")
		winPath, err = pickWindowsFolder()
	}
	if err != nil || winPath == "" {
		fmt.Println("  No folder selected. Skipping.")
		return
	}
	fmt.Printf("  Selected: %s\n", winPath)

	folderName := filepath.Base(winPath)
	slug := slugify(folderName)
	if slug == "" {
		slug = "kb-folder"
	}

	mirrorDest := filepath.Join(exeDir, "knowledge_base_data", slug)
	if err := os.MkdirAll(mirrorDest, 0755); err != nil {
		fmt.Printf("  [ERROR] Could not create mirror directory %s: %v\n", mirrorDest, err)
		return
	}

	fmt.Printf("  [1/3] Copying files from %s -> %s\n", winPath, mirrorDest)
	fmt.Println("        (Initial copy pass in progress; indexing begins after copy finishes)...")
	if err := runInitialCopy(winPath, mirrorDest); err != nil {
		fmt.Printf("  [ERROR] Initial copy failed: %v\n", err)
		return
	}
	fmt.Println("        ✓ Initial copy pass completed successfully.")

	fmt.Println("  [2/3] Starting continuous background synchronization...")
	if err := startRobocopyBackground(winPath, mirrorDest); err != nil {
		fmt.Printf("  [WARNING] Background sync start failed: %v\n", err)
	} else {
		fmt.Println("        ✓ Background sync started (one-way copy, non-destructive).")
	}

	containerPath := "/kb_data/" + slug
	fmt.Printf("  [3/3] Registering folder with backend as %s…\n", containerPath)
	folderID, regErr := registerKBFolder(containerPath, folderName, token)
	if regErr != nil {
		fmt.Printf("  [WARNING] Registration failed: %v\n", regErr)
		fmt.Println()
		fmt.Println("  ┌─────────────────────────────────────────────────────────┐")
		fmt.Println("  │  Manual step:                                           │")
		fmt.Println("  │  1. Log in at http://localhost:5173                     │")
		fmt.Println("  │  2. Go to Knowledge Base → Add Folder                  │")
		fmt.Printf("  │  3. Enter path: %-40s│\n", containerPath)
		fmt.Println("  └─────────────────────────────────────────────────────────┘")
	} else {
		fmt.Printf("  ✓ Folder registered (ID %d) and indexing started.\n", folderID)
		saveKBMapping(exeDir, KBMapping{
			SourcePath:    winPath,
			Slug:          slug,
			DestPath:      mirrorDest,
			ContainerPath: containerPath,
			FolderName:    folderName,
			CreatedAt:     time.Now().Format(time.RFC3339),
		})
	}
}

// pickWindowsFolder opens the native Windows folder picker dialog via PowerShell.
func pickWindowsFolder() (string, error) {
	psScript := `
$app = New-Object -ComObject Shell.Application
$folder = $app.BrowseForFolder(0, 'Select a folder to add to StarkLLM Knowledge Base', 0)
if ($folder) { $folder.Self.Path } else { '' }
`
	out, err := exec.Command(
		"powershell", "-NoProfile", "-Command", psScript,
	).Output()
	if err != nil {
		return "", fmt.Errorf("PowerShell folder picker failed: %w", err)
	}
	path := strings.TrimSpace(string(out))
	return path, nil
}

// slugify converts a folder display name to a safe directory slug.
func slugify(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else if r == ' ' || r == '_' || r == '-' {
			b.WriteByte('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}

// KBFolderRegistration is the minimal API response structure.
type KBFolderRegistration struct {
	ID int `json:"id"`
}

// registerKBFolder calls the loopback-only launcher endpoint.
// It supplies the launcher token and waits if the user has not logged in yet.
func registerKBFolder(containerPath, displayName, token string) (int, error) {
	type reqBody struct {
		FolderPath    string `json:"folder_path"`
		FolderName    string `json:"folder_name"`
		LauncherToken string `json:"launcher_token"`
	}
	body := reqBody{
		FolderPath:    containerPath,
		FolderName:    displayName,
		LauncherToken: token,
	}
	bodyBytes, _ := json.Marshal(body)

	client := http.Client{Timeout: 10 * time.Second}
	var lastErr error

	for attempt := 0; attempt < 30; attempt++ {
		req, err := http.NewRequest("POST", "http://127.0.0.1:8000/launcher/register-kb-folder",
			strings.NewReader(string(bodyBytes)))
		if err != nil {
			return 0, err
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("connection failed: %w", err)
			time.Sleep(3 * time.Second)
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode == 201 || resp.StatusCode == 200 {
			var result KBFolderRegistration
			_ = json.NewDecoder(resp.Body).Decode(&result)
			return result.ID, nil
		}

		if resp.StatusCode == 401 {
			if attempt%4 == 0 {
				fmt.Println("  [INFO] Please log in to StarkLLM at http://localhost:5173 to complete registration...")
			}
			time.Sleep(3 * time.Second)
			continue
		}

		var errResp struct {
			Detail string `json:"detail"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&errResp)
		msg := errResp.Detail
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return 0, fmt.Errorf("%s", msg)
	}

	if lastErr != nil {
		return 0, lastErr
	}
	return 0, fmt.Errorf("timeout waiting for authenticated user session at http://localhost:5173")
}
