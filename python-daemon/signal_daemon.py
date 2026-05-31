#!/usr/bin/env python3
"""
Industrial IoT Pin Signal Daemon

This daemon generates random pin signals and sends them to the Node.js backend
via HTTP requests. It simulates PLC digital input signals for testing purposes.
"""

import asyncio
import logging
import json
import os
import time
import random
from datetime import datetime
from typing import Dict, List
import signal
import sys
import requests
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('signal_daemon.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

class PinSignalGenerator:
    """Generates random pin signals for testing"""
    
    def __init__(self, num_pins: int = 8):
        self.num_pins = num_pins
        self.pin_states = [0] * num_pins
        self.last_cycle_times = {}
        self.production_cycles = {}  # Track production cycles per machine
        
    def generate_signals(self) -> bytes:
        """Generate random pin signals as a byte"""
        # Simulate realistic behavior
        for i in range(self.num_pins):
            # Power sensors (pins 0-3) - more stable, occasional changes
            if i < 4:
                if random.random() < 0.5:  # 5% chance to change
                    self.pin_states[i] = random.choice([0, 1])
            # Unit cycle sensors (pins 4-7) - periodic pulses for production
            else:
                # Simulate production cycles - more frequent during "working hours"
                current_hour = datetime.now().hour
                
                # Higher production rate during working hours (8 AM - 6 PM)
                if 8 <= current_hour <= 18:
                    cycle_probability = 0.15  # 15% chance for cycle pulse
                else:
                    cycle_probability = 0.05  # 5% chance during off hours
                
                if random.random() < cycle_probability:
                    self.pin_states[i] = 1
                    self.last_cycle_times[i] = time.time()
                    logger.info(f"Production cycle detected on pin DQ.{i}")
                elif i in self.last_cycle_times:
                    # Reset after short pulse (1-2 seconds)
                    if time.time() - self.last_cycle_times[i] > random.uniform(1, 2):
                        self.pin_states[i] = 0
        
        # Convert pin states to byte
        byte_value = 0
        for i, state in enumerate(self.pin_states):
            if state:
                byte_value |= (1 << i)
                
        return bytes([byte_value])
    
    def get_pin_description(self, byte_data: bytes) -> str:
        """Get human readable description of pin states"""
        byte_value = byte_data[0]
        active_pins = []
        
        for i in range(self.num_pins):
            if byte_value & (1 << i):
                active_pins.append(f"DQ.{i}")
        
        return f"Active pins: {', '.join(active_pins) if active_pins else 'None'}"

class SignalDaemon:
    """Main daemon class for sending pin signals"""
    
    def __init__(self, config_file: str = "config.json"):
        self.config = self.load_config(config_file)
        self.generator = PinSignalGenerator()
        self.running = False
        # Env vars take precedence over config.json so secrets stay out of the file.
        self.backend_url = os.environ.get('BACKEND_URL') or self.config.get('backend', {}).get('url', 'http://localhost:3001')
        self.api_key = os.environ.get('DAEMON_API_KEY') or self.config.get('daemon', {}).get('api_key', '')
        
        # Setup signal handlers for graceful shutdown
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)
        
    def load_config(self, config_file: str) -> Dict:
        """Load configuration from JSON file"""
        default_config = {
            "backend": {
                "url": "http://localhost:3001"
            },
            "daemon": {
                "interval_seconds": 1,  # Send signals every 2 seconds
                "retry_attempts": 3,
                "retry_delay": 5
            },
            "logging": {
                "level": "INFO"
            }
        }
        
        try:
            if Path(config_file).exists():
                with open(config_file, 'r') as f:
                    config = json.load(f)
                    # Merge with defaults
                    for key, value in default_config.items():
                        if key not in config:
                            config[key] = value
                        elif isinstance(value, dict):
                            for subkey, subvalue in value.items():
                                if subkey not in config[key]:
                                    config[key][subkey] = subvalue
                return config
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
        """Send pin signals to backend"""
        try:
            payload = {
                'pinData': pin_data.hex(),
                'timestamp': datetime.now().isoformat()
            }
            
            headers = {'X-API-Key': self.api_key} if self.api_key else {}
            response = requests.post(
                f"{self.backend_url}/api/signals/pin-data",
                json=payload,
                headers=headers,
                timeout=10
            )
            
            if response.status_code == 200:
                result = response.json()
                if result.get('processedMachines'):
                    logger.info(f"Pin data processed for machines: {result['processedMachines']}")
                else:
                    logger.debug(f"Pin data sent: {self.generator.get_pin_description(pin_data)}")
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
    
    async def run(self):
        """Main daemon loop"""
        self.running = True
        logger.info("Pin Signal Daemon started - sending signals every 2 seconds")
        
        retry_count = 0
        max_retries = self.config['daemon']['retry_attempts']
        
        try:
            while self.running:
                # Generate pin signals
                pin_data = self.generator.generate_signals()
                
                # Send to backend
                success = await self.send_pin_signals(pin_data)
                
                if success:
                    retry_count = 0  # Reset retry counter on success
                else:
                    retry_count += 1
                    if retry_count >= max_retries:
                        logger.warning(f"Failed to send signals {max_retries} times, continuing...")
                        retry_count = 0
                
                # Wait for next interval
                await asyncio.sleep(self.config['daemon']['interval_seconds'])
                
        except Exception as e:
            logger.error(f"Error in main loop: {e}")
        
        finally:
            await self.shutdown()
    
    async def shutdown(self):
        """Cleanup and shutdown"""
        logger.info("Shutting down Pin Signal Daemon...")
        logger.info("Pin Signal Daemon stopped")

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