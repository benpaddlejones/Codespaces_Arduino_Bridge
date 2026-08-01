// Fixture: setup() is never closed, so the closing brace is missing.
// Expected category: unmatched_brace
void setup() {
  Serial.begin(9600);
void loop() {}
