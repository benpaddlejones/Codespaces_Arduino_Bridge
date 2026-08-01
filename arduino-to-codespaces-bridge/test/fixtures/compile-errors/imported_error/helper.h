#ifndef HELPER_H
#define HELPER_H
// The mistake lives here: notDeclaredInHeader is never defined. The compiler
// reports this file (helper.h), which is what the analyzer must surface.
inline void helperInit() {
  int value = notDeclaredInHeader + 1;
  Serial.println(value);
}
#endif
