// Fixture: two large PROGMEM tables overflow the UNO's 32 KB flash.
// Expected category: flash_overflow
#include <avr/pgmspace.h>
const unsigned char big[20000] PROGMEM = {1};
const unsigned char big2[20000] PROGMEM = {2};
void setup() { Serial.begin(9600); }
void loop() {
  Serial.println(pgm_read_byte(&big[millis() % 20000]));
  Serial.println(pgm_read_byte(&big2[millis() % 20000]));
}
