package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/rs/zerolog"
)

type PortDetector struct {
	knownPorts map[int]struct{}
	interval   time.Duration
	portCh     chan int
	logger     zerolog.Logger
}

func newPortDetector(interval time.Duration, logger zerolog.Logger) *PortDetector {
	return &PortDetector{
		knownPorts: make(map[int]struct{}),
		interval:   interval,
		portCh:     make(chan int, 10),
		logger:     logger,
	}
}

// ReadListening reads from /proc/net/tcp for listening ports
func (p *PortDetector) ReadListening() ([]int, error) {
	file, err := os.Open("/proc/net/tcp")
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var ports []int
	scanner := bufio.NewScanner(file)

	// Skip header line
	scanner.Scan()

	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)

		if len(fields) < 4 {
			continue
		}

		// Field 1 is local_address (format: "0100007F:1F90" = 127.0.0.1:8080)
		// Field 3 is st (state: 0A = LISTEN)
		localAddr := fields[1]
		state := fields[3]

		// Only interested in LISTEN state (0A in hex)
		if state != "0A" {
			continue
		}

		// Parse port from local_address
		parts := strings.Split(localAddr, ":")
		if len(parts) != 2 {
			continue
		}

		// Convert hex port to decimal
		portHex := parts[1]
		port, err := strconv.ParseInt(portHex, 16, 32)
		if err != nil {
			continue
		}

		ports = append(ports, int(port))
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return ports, nil
}

// DetectExisting scans for existing listening ports on startup
func (p *PortDetector) DetectExisting() {
	ports, err := p.ReadListening()
	if err != nil {
		p.logger.Error().Err(err).Msg("Failed initial port scan")
		return
	}

	for _, port := range ports {
		p.knownPorts[port] = struct{}{}
		p.logger.Info().Int("port", port).Msg("Existing port detected")
		p.portCh <- port
	}

	p.logger.Info().Int("count", len(p.knownPorts)).Msg("Initial scan complete")
}

// watchForNewPorts monitors for new listening ports periodically
func (p *PortDetector) WatchNew() {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for range ticker.C {
		ports, err := p.ReadListening()
		if err != nil {
			p.logger.Error().Err(err).Msg("Failed to detect ports")
			continue
		}

		currentPorts := make(map[int]struct{})
		for _, port := range ports {
			currentPorts[port] = struct{}{}

			// New port detected
			if _, exists := p.knownPorts[port]; !exists {
				p.logger.Info().Int("port", port).Msg("New port detected")
				p.portCh <- port
			}
		}

		// Update known ports
		p.knownPorts = currentPorts
	}
}

// Start begins port detection (existing + continuous monitoring)
func (p *PortDetector) Start() {
	p.DetectExisting()
	p.WatchNew()
}

// notifyClient sends outbound stream that notifies client about a detected port
func (p *PortDetector) NotifyClient(session *yamux.Session, port int) {
	stream, err := session.OpenStream()
	if err != nil {
		p.logger.Error().Err(err).Int("port", port).Msg("Failed to open stream")
		return
	}
	defer stream.Close()

	// Send port notification to client
	message := map[string]int{
		"port": port,
	}

	encoder := json.NewEncoder(stream)
	if err := encoder.Encode(message); err != nil {
		p.logger.Error().Err(err).Int("port", port).Msg("Failed to encode port detected notification message")
		return
	}

	p.logger.Info().Int("port", port).Msg("Notified client about new port")
}
