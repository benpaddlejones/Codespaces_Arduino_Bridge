// Fixture: main sketch is correct, but it includes a local header that
// contains the bug. The analyzer must report the error in helper.h, NOT in
// this .ino file.
#include "helper.h"
void setup() {
  Serial.begin(9600);
  helperInit();
}
void loop() {}
