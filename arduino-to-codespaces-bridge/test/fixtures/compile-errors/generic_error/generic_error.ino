// Fixture: a function call with too few arguments (a hard error not covered
// by a more specific category).
// Expected category: compile_error
void setup() {
  Serial.begin(9600);
  pinMode(13);
}
void loop() {}
