// Fixture: includes a real, uninstalled sensor library.
// Expected category: missing_header (DHT.h)
#include <DHT.h>
DHT dht(2, DHT22);
void setup() {
  Serial.begin(9600);
  dht.begin();
}
void loop() {}
