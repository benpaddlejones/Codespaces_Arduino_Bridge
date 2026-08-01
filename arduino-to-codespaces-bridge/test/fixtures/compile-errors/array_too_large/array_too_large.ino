// Fixture: a single PROGMEM array larger than the 16-bit index range.
// Expected category: array_too_large
#include <avr/pgmspace.h>
const PROGMEM unsigned char big[40000] = {1};
void setup() {
  Serial.begin(9600);
  Serial.println(pgm_read_byte(&big[0]));
}
void loop() {}
