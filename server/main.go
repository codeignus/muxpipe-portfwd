package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/rs/zerolog"
)

var logger zerolog.Logger

func init() {
	var logFile string
	flag.StringVar(&logFile, "log-file", "", "Path to log file (if not specified, logs to stderr)")
	flag.Parse()

	var logWriter io.Writer = os.Stderr
	if logFile != "" {
		file, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
		if err != nil {
			// Print error to stderr and exit
			fmt.Fprintf(os.Stderr, "Error: Failed to open log file %s: %v\n", logFile, err)
			os.Exit(1)
		}
		logWriter = file
	}

	logger = zerolog.New(logWriter).
		With().
		Timestamp().
		Str("source", "server").
		Logger()

	if logFile != "" {
		// Inform about log file location on stderr
		fmt.Fprintf(os.Stderr, "Collecting server logs at file: %s\n", logFile)
	}
}

func main() {
	logger.Info().Msg("Starting server")

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	session := createYamuxSession()
	defer session.Close()

	// Accept streams in a goroutine
	streamChan := make(chan *yamux.Stream)
	streamErrChan := make(chan error, 1)

	go func() {
		for {
			stream, err := session.AcceptStream()
			if err != nil {
				streamErrChan <- err
				return
			}
			streamChan <- stream
		}
	}()

	// Both event loops started above
	logger.Debug().Msg("Event loop started, waiting for streams")

	// Select loop to coordinate events
	for {
		select {
		case stream := <-streamChan:
			logger.Info().Uint32("streamId", stream.StreamID()).Msg("Stream accepted, starting handler")
			go handleIncomingStream(stream)

		case err := <-streamErrChan:
			if err != io.EOF {
				logger.Error().Err(err).Msg("Error accepting stream")
			}
			logger.Info().Msg("Server shutting down")
			return

		case sig := <-sigChan:
			logger.Info().Str("signal", sig.String()).Msg("Received shutdown signal")
			return
		}
	}
}

func createYamuxSession() *yamux.Session {
	config := yamux.DefaultConfig()
	config.EnableKeepAlive = true
	config.KeepAliveInterval = 30 * time.Second
	// Increase timeout significantly for stdio-based connections
	// Stdio pipes can experience backpressure, so we need generous timeouts
	config.ConnectionWriteTimeout = 1 * time.Minute
	config.LogOutput = logger

	logger.Debug().
		Bool("keepAliveEnabled", config.EnableKeepAlive).
		Dur("keepAliveInterval", config.KeepAliveInterval).
		Dur("connectionWriteTimeout", config.ConnectionWriteTimeout).
		Msg("Yamux config initialized")

	// Wrap stdin/stdout as a ReadWriteCloser
	stdio := &stdioConn{
		reader: os.Stdin,
		writer: os.Stdout,
	}

	// Create a Yamux server session
	session, err := yamux.Server(stdio, config)
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to initialize yamux session")
	}

	logger.Trace().Msg("Yamux session created, verifying client readiness")

	// Wait for client to be ready by pinging
	for i := range 100 {
		time.Sleep(20 * time.Millisecond)
		_, err := session.Ping()
		if err == nil {
			logger.Debug().Int("attempts", i+1).Msg("Successfully pinged the client")
			break
		}
		if i == 99 {
			logger.Fatal().Err(err).Msg("Client failed to respond to ping")
		}
	}

	return session
}

// stdioConn wraps stdin/stdout as a net.Conn-like ReadWriteCloser
type stdioConn struct {
	reader io.Reader
	writer io.Writer
}

func (rw *stdioConn) Read(p []byte) (int, error) {
	return rw.reader.Read(p)
}

func (rw *stdioConn) Write(p []byte) (int, error) {
	return rw.writer.Write(p)
}

func (rw *stdioConn) Close() error {
	// You generally don't close stdin/stdout, so just return nil
	return nil
}
