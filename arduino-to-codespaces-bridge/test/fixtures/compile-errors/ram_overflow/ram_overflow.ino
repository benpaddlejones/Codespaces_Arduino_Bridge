// Fixture: a large global array overflows the UNO's 2 KB SRAM.
// Expected category: ram_overflow
int big[1500] = {1};
void setup() { Serial.begin(9600); }
void loop() {
  for (int i = 0; i < 1500; i++) Serial.println(big[i]);
}
