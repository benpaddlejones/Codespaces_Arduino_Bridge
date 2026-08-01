// Fixture: variable used before it is declared.
// Expected category: undeclared_identifier
void setup() {
  Serial.begin(9600);
  Serial.println(counter);
}
void loop() {}
