/*
 * Upload Validation Sketch
 * ========================
 * Small (<8KB) cross-board test that PROVES an upload succeeded:
 *
 *  1. BUILD FINGERPRINT: prints the compile date/time at boot. Every
 *     re-compile produces a new fingerprint, so if the banner matches the
 *     time you clicked Compile & Upload, the NEW firmware is running -
 *     not the old one. This is the 100% upload validation.
 *  2. BOARD IDENTITY: prints which board the core compiled for, proving
 *     the correct core/protocol path was used.
 *  3. VISUAL CHECK: 3 fast LED blinks at boot, then 1Hz heartbeat -
 *     validates upload even when serial reconnect fails (DFU boards).
 *  4. SERVO LIBRARY: sweeps a servo on pin 9 using every common loop
 *     type (for, while, do-while) - validates library linking + PWM.
 *  5. PLOTTER FEED: prints "angle:<n>" lines - validates the serial
 *     plotter with live data.
 *  6. LOOP COUNTER: numbered heartbeat messages prove the sketch keeps
 *     running (no crash/watchdog reset loop).
 *
 * Wiring (optional): servo signal -> pin 9, servo VCC -> 5V, GND -> GND.
 * The sketch works with nothing attached - PWM is still generated.
 */

#include <Servo.h>

// Identify the board at compile time (proves correct core was used)
#if defined(ARDUINO_AVR_UNO)
#define BOARD_NAME "Arduino Uno (AVR / STK500)"
#elif defined(ARDUINO_AVR_NANO)
#define BOARD_NAME "Arduino Nano (AVR / STK500)"
#elif defined(ARDUINO_AVR_MEGA2560)
#define BOARD_NAME "Arduino Mega 2560 (AVR / STK500)"
#elif defined(ARDUINO_AVR_LEONARDO)
#define BOARD_NAME "Arduino Leonardo (AVR)"
#elif defined(ARDUINO_UNOWIFIR4) || defined(ARDUINO_UNOR4_WIFI)
#define BOARD_NAME "Arduino Uno R4 WiFi (Renesas / BOSSA)"
#elif defined(ARDUINO_MINIMA) || defined(ARDUINO_UNOR4_MINIMA)
#define BOARD_NAME "Arduino Uno R4 Minima (Renesas / DFU)"
#elif defined(ARDUINO_ARDUINO_NANO33BLE)
#define BOARD_NAME "Arduino Nano 33 BLE (nRF52 / BOSSA)"
#elif defined(ARDUINO_SAMD_NANO_33_IOT)
#define BOARD_NAME "Arduino Nano 33 IoT (SAMD / BOSSA)"
#elif defined(ARDUINO_SAMD_MKR1000)
#define BOARD_NAME "Arduino MKR1000 (SAMD / BOSSA)"
#elif defined(ESP32)
#define BOARD_NAME "ESP32 (ESPTool)"
#elif defined(ARDUINO_ARCH_RP2040)
#define BOARD_NAME "RP2040 (UF2)"
#else
#define BOARD_NAME "Unknown board (check FQBN)"
#endif

const int SERVO_PIN = 9;
const int LED_PIN = LED_BUILTIN;

Servo testServo;
unsigned long loopCount = 0;
unsigned long lastHeartbeat = 0;

void printBanner() {
  Serial.println();
  Serial.println(F("=================================================="));
  Serial.println(F("  UPLOAD VALIDATION SKETCH"));
  Serial.print(F("  Board:  "));
  Serial.println(F(BOARD_NAME));
  // BUILD FINGERPRINT: must match the time you compiled!
  Serial.print(F("  Built:  "));
  Serial.print(F(__DATE__));
  Serial.print(F(" "));
  Serial.println(F(__TIME__));
  Serial.println(F("  If 'Built' matches your compile time, the"));
  Serial.println(F("  upload replaced the old firmware: PASS"));
  Serial.println(F("=================================================="));
}

void setup() {
  pinMode(LED_PIN, OUTPUT);

  Serial.begin(115200);
  // Native-USB boards: wait briefly for the monitor to attach
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 3000) {
    delay(10);
  }

  printBanner();

  // VISUAL CHECK: 3 fast blinks = new sketch booted (for loop #1)
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(120);
    digitalWrite(LED_PIN, LOW);
    delay(120);
  }

  testServo.attach(SERVO_PIN);
  Serial.println(F("[servo] Attached on pin 9"));
}

void loop() {
  loopCount++;

  // --- for loop: sweep servo 0 -> 180 ---
  Serial.println(F("[servo] Sweep up (for loop)"));
  for (int angle = 0; angle <= 180; angle += 5) {
    testServo.write(angle);
    Serial.print(F("angle:"));
    Serial.println(angle); // plotter-friendly output
    delay(30);
  }

  // --- while loop: sweep servo 180 -> 0 ---
  Serial.println(F("[servo] Sweep down (while loop)"));
  int angle = 180;
  while (angle >= 0) {
    testServo.write(angle);
    Serial.print(F("angle:"));
    Serial.println(angle);
    angle -= 5;
    delay(30);
  }

  // --- do-while loop: centre pulse 3 times ---
  Serial.println(F("[servo] Centre pulses (do-while loop)"));
  int pulses = 0;
  do {
    testServo.write(90);
    digitalWrite(LED_PIN, HIGH);
    delay(150);
    testServo.write(60);
    digitalWrite(LED_PIN, LOW);
    delay(150);
    pulses++;
  } while (pulses < 3);

  // --- millis()-based non-blocking heartbeat (common Arduino pattern) ---
  unsigned long waitStart = millis();
  while (millis() - waitStart < 2000) {
    if (millis() - lastHeartbeat >= 1000) {
      lastHeartbeat = millis();
      digitalWrite(LED_PIN, !digitalRead(LED_PIN));
      Serial.print(F("[heartbeat] pass "));
      Serial.print(loopCount);
      Serial.print(F(", uptime "));
      Serial.print(millis() / 1000);
      Serial.println(F("s - still running: PASS"));
    }
  }
}
