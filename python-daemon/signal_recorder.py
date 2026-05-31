#!/usr/bin/env python3
"""
Industrial IoT Pin Signal Daemon (PLC Version)
"""

import asyncio
import logging
import json
import os
import time
from datetime import datetime
import signal
import sys
import requests
from pathlib import Path
import snap7
from snap7.client import Area
from snap7.util import get_bool

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('plc_signal_daemon.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

class PLCReader:
    """Handles PLC connection and data reading using proven method"""
    
    def __init__(self, ip: str, rack: int = 0, slot: int = 1):
        self.ip = ip
        self.rack = rack
        self.slot = slot
        self.client = snap7.client.Client()
        self.connected = False
        
    def connect(self) -> bool:
        """Connect to PLC"""
        try:
            logger.info(f"Connecting to PLC at {self.ip} (Rack: {self.rack}, Slot: {self.slot})")
            self.client.connect(self.ip, self.rack, self.slot)
            
            # Simple test read to verify connection
            try:
                test_data = self.client.read_area(Area.PA, 0, 0, 1)
                logger.info("PLC connection test successful")
                self.connected = True
            except Exception as test_error:
                logger.error(f"PLC connection test failed: {test_error}")
                self.connected = False
            
            return self.connected
        except Exception as e:
            logger.error(f"Failed to connect to PLC: {e}")
            self.connected = False
            return False
    
    def disconnect(self):
        """Disconnect from PLC"""
        if self.connected:
            self.client.disconnect()
            self.connected = False
            logger.info("Disconnected from PLC")
    
    def read_digital_byte(self) -> bytes:
        """Read digital input byte from PLC using proven method"""
        try:
            if not self.connected:
                # Try to reconnect if connection was lost
                if not self.connect():
                    return b'\x00'
            
            # Read from outputs area (Q area) as in your working example
            data = self.client.read_area(Area.PA, 0, 0, 1)
            return data
            
        except Exception as e:
            logger.error(f"Error reading PLC data: {e}")
            self.connected = False
            return b'\x00'

class SignalDaemon:
    """Main daemon class for sending pin signals from PLC"""
    
    def __init__(self, config_file: str = "config.json"):
        self.config = self.load_config(config_file)
        self.plc = PLCReader(
            ip=self.config['plc']['ip'],
            rack=self.config['plc']['rack'],
            slot=self.config['plc']['slot']
        )
        self.running = False
        # Env vars take precedence over config.json so secrets stay out of the file.
        self.backend_url = os.environ.get('BACKEND_URL') or self.config['backend']['url']
        self.api_key = os.environ.get('DAEMON_API_KEY') or self.config['daemon'].get('api_key', '')
        if not self.api_key:
            logger.warning(
                "No DAEMON_API_KEY set (env or config.json). The backend will reject "
                "ingestion with 401 once API-key auth is enabled."
            )

        # Setup signal handlers for graceful shutdown
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)
        
    def load_config(self, config_file: str) -> dict:
        """Load configuration from JSON file"""
        # Default configuration matching your working example
        default_config = {
            "backend": {
                "url": "http://localhost:3001"
            },
            "plc": {
                "ip": "192.168.0.1",
                "rack": 0,
                "slot": 1
            },
            "daemon": {
                "interval_seconds": 0,
                "retry_attempts": 3,
                "retry_delay": 5,
                "request_timeout": 10
            }
        }
        
        try:
            if Path(config_file).exists():
                with open(config_file, 'r') as f:
                    config = json.load(f)
                    # Merge with defaults
                    for key in default_config:
                        if key in config:
                            default_config[key].update(config[key])
                    return default_config
            else:
                logger.warning(f"Config file {config_file} not found, using defaults")
                return default_config
                
        except Exception as e:
            logger.error(f"Error loading config: {e}, using defaults")
            return default_config
    
    def signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        logger.info(f"Received signal {signum}, shutting down...")
        self.running = False
    
    async def send_pin_signals(self, pin_data: bytes) -> bool:
        """Send pin signals to backend with enhanced logging and response handling"""
        try:
            payload = {
                'pinData': pin_data.hex(),
                'timestamp': datetime.now().isoformat()
            }
            
            # Get timeout from config with default fallback
            timeout = self.config['daemon'].get('request_timeout', 10)

            headers = {'X-API-Key': self.api_key} if self.api_key else {}
            response = requests.post(
                f"{self.backend_url}/api/signals/pin-data",
                json=payload,
                headers=headers,
                timeout=timeout
            )
            
            if response.status_code == 200:
                result = response.json()
                if result.get('processedMachines'):
                    logger.info(f"Pin data processed for machines: {result['processedMachines']}")
                else:
                    pin_desc = self.get_pin_description(pin_data)
                    logger.debug(f"Pin data sent: {pin_desc}")
                return True
            else:
                logger.error(f"Backend returned status {response.status_code}: {response.text}")
                return False
                
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to send pin signals: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error sending signals: {e}")
            return False
            
    def get_pin_description(self, byte_data: bytes) -> str:
        """Get human readable description of pin states"""
        if not byte_data:
            return "No data"
        
        # Parse the byte to get individual pin states
        active_pins = []
        for i in range(8):
            try:
                # Use the same method as in your working example
                pin_state = get_bool(byte_data, 0, i)
                if pin_state:
                    active_pins.append(f"Q0.{i}")
            except:
                pass
        
        return f"Active pins: {', '.join(active_pins)}" if active_pins else "No active pins"
    
    async def run(self):
        """Main daemon loop with retry mechanism"""
        self.running = True
        
        # Connect to PLC
        if not self.plc.connect():
            logger.error("Failed to connect to PLC. Exiting.")
            return
            
        logger.info(f"PLC Signal Daemon started - reading signals every {self.config['daemon']['interval_seconds']} seconds")
        
        # Initialize retry parameters
        retry_count = 0
        max_retries = self.config['daemon'].get('retry_attempts', 3)
        retry_delay = self.config['daemon'].get('retry_delay', 5)
        
        while self.running:
            try:
                # Read pin signals from PLC
                pin_data = self.plc.read_digital_byte()
                
                # Send to backend with retry logic
                success = await self.send_pin_signals(pin_data)
                
                if success:
                    retry_count = 0  # Reset retry counter on success
                else:
                    retry_count += 1
                    if retry_count >= max_retries:
                        logger.warning(f"Failed to send signals {max_retries} times. Waiting {retry_delay} seconds before retry")
                        await asyncio.sleep(retry_delay)
                        retry_count = 0  # Reset after waiting
                
            except Exception as e:
                logger.error(f"Error in main loop: {e}")
                retry_count += 1
                if retry_count >= max_retries:
                    logger.error(f"Critical error after {max_retries} attempts: {e}")
                    self.running = False
            
            # Wait for next interval
            await asyncio.sleep(self.config['daemon']['interval_seconds'])
        
        await self.shutdown()
    
    async def shutdown(self):
        """Cleanup and shutdown"""
        logger.info("Shutting down PLC Signal Daemon...")
        self.plc.disconnect()
        logger.info("PLC Signal Daemon stopped")

def main():
    """Main entry point"""
    daemon = SignalDaemon()
    
    try:
        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        logger.info("Daemon interrupted by user")
    except Exception as e:
        logger.error(f"Daemon crashed: {e}")

if __name__ == "__main__":
    main()