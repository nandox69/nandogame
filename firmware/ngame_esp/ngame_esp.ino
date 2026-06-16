/*
 * NANDO GAME - Firmware ESP32
 * =============================
 * Conexion WiFi + MQTT al servidor NandoGame.
 * Reporta monedas, premios y estado de power.
 *
 * Configurar WiFi y servidor MQTT abajo.
 * Usar IDE de Arduino con soporte ESP32.
 */

#include <WiFi.h>
#include <PubSubClient.h>

// ---- CONFIGURACION ----
const char* WIFI_SSID     = "XXXXXX";
const char* WIFI_PASS     = "XXXXXX";
const char* MQTT_SERVER   = "app.ngame.cl";
const int   MQTT_PORT     = 8080;
const char* MQTT_USER     = "";
const char* MQTT_PASS     = "";
const char* MACHINE_ID    = "M0001";
const char* API_KEY       = "nk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
// -----------------------

#define PIN_MONEDERO 32
#define PIN_PREMIOS  33
#define PIN_RELE     25

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

unsigned long lastReport = 0;
unsigned long lastRSSI   = 0;
int pulseCoin = 0, pulsePrize = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_MONEDERO, INPUT_PULLUP);
  pinMode(PIN_PREMIOS,  INPUT_PULLUP);
  pinMode(PIN_RELE,     OUTPUT);
  digitalWrite(PIN_RELE, HIGH);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); }

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(callback);
}

void callback(char* topic, byte* payload, unsigned int len) {
  String msg = "";
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];

  String t = String(topic);
  String base = "nandogame/" + String(MACHINE_ID) + "/";

  if (t == base + "power") {
    digitalWrite(PIN_RELE, (msg == "ON") ? LOW : HIGH);
    mqtt.publish((base + "status").c_str(), (msg == "ON") ? "online" : "offline");
  }
}

void reconnect() {
  while (!mqtt.connected()) {
    String id = "ng_" + String(MACHINE_ID);
    if (mqtt.connect(id.c_str(), MQTT_USER, MQTT_PASS)) {
      String base = "nandogame/" + String(MACHINE_ID) + "/";
      mqtt.subscribe((base + "power").c_str());
      mqtt.subscribe((base + "relay_active_low").c_str());
      mqtt.publish((base + "status").c_str(), "online");
    }
  }
}

void loop() {
  if (!mqtt.connected()) reconnect();
  mqtt.loop();

  static int lastCoin = HIGH;
  int coinVal = digitalRead(PIN_MONEDERO);
  if (coinVal == LOW && lastCoin == HIGH) pulseCoin++;
  lastCoin = coinVal;

  static int lastPrize = HIGH;
  int prizeVal = digitalRead(PIN_PREMIOS);
  if (prizeVal == LOW && lastPrize == HIGH) pulsePrize++;
  lastPrize = prizeVal;

  if (millis() - lastReport > 3000) {
    lastReport = millis();
    String base = "nandogame/" + String(MACHINE_ID) + "/";
    if (pulseCoin > 0) {
      mqtt.publish((base + "monedas").c_str(), String(pulseCoin).c_str());
      pulseCoin = 0;
    }
    if (pulsePrize > 0) {
      mqtt.publish((base + "premios").c_str(), String(pulsePrize).c_str());
      pulsePrize = 0;
    }
  }

  if (millis() - lastRSSI > 60000) {
    lastRSSI = millis();
    mqtt.publish((String("nandogame/") + MACHINE_ID + "/rssi").c_str(), String(WiFi.RSSI()).c_str());
  }
}
