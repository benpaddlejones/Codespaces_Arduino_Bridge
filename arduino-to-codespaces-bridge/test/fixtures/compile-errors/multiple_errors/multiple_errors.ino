// Fixture: several independent mistakes the compiler reports together.
// Expected: three undeclared_identifier + one compile_error, all identified.
void setup() {
  Serial.begin(9600);
  Serial.println(firstMissing);
  digitalWrite(secondMissing, HIGH);
  pinMode(13);
}
void loop() {
  int x = notDeclaredHere + 1;
}
