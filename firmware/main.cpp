#include <WiFi.h>
#include <HTTPClient.h>
#include <EEPROM.h>
#include <DHT.h>
#include <Adafruit_NeoPixel.h>


// ── Built-in RGB LED (ESP32-S3) ───────────────────────────────────────────────
#define LED_PIN   48    // GPIO48 on ESP32-S3
#define LED_COUNT  1
Adafruit_NeoPixel led(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

// ── Sensor pins ──────────────────────────────────────────────────────────────
#define DHT_PIN   4
#define MQ135_PIN 7

// ── MQ135 constants ───────────────────────────────────────────────────────────
#define RL         10.0f
#define VC          3.3f
#define R0_DEFAULT 10.0f

// ── Timing ────────────────────────────────────────────────────────────────────
#define SAMPLE_INTERVAL_MS  5000
#define SEND_INTERVAL_MS   60000

DHT dht(DHT_PIN, DHT11);

float R0 = 0;
float tempSum = 0, humSum = 0, co2Sum = 0;
int   sampleCount = 0;

unsigned long lastSampleTime = 0;
unsigned long lastSendTime   = 0;

// ── LED helpers ───────────────────────────────────────────────────────────────
void setLED(uint8_t r, uint8_t g, uint8_t b) {
  led.setPixelColor(0, led.Color(r, g, b));
  led.show();
}

// ── WiFi ──────────────────────────────────────────────────────────────────────
void connectWiFi() {
  setLED(255, 165, 0);  // Orange while connecting
  WiFi.begin("jeeva's OnePlus 11", "12345678");
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected. Gateway: ");
  Serial.println(WiFi.gatewayIP().toString());
  setLED(0, 255, 0);    // Green when connected
}

void sendData(float avgTemp, float avgHum, float avgCO2) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected, skipping send.");
    setLED(255, 0, 0);  // Red if disconnected
    return;
  }

  String url     = "http://your-api-link.com/sensor";
  String payload = "{\"temperature\":" + String(avgTemp, 2)
                 + ",\"humidity\":"    + String(avgHum,  2)
                 + ",\"co2_ppm\":"     + String(avgCO2,  2) + "}";

  const int MAX_ATTEMPTS = 3;
  for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(8000);

    int code = http.POST(payload);
    if (code > 0) {
      Serial.printf("POST -> HTTP %d (attempt %d)\n", code, attempt);
      http.end();
      return;
    }

    Serial.printf("POST attempt %d/%d failed: %s\n", attempt, MAX_ATTEMPTS,
                  HTTPClient::errorToString(code).c_str());
    http.end();
    if (attempt < MAX_ATTEMPTS) delay(1000);
  }

  Serial.println("All POST attempts failed, dropping reading.");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  EEPROM.begin(512);
  dht.begin();

  led.begin();
  led.setBrightness(50);  // 0-255, keep low to avoid power issues
  setLED(0, 0, 0);        // Off initially

  EEPROM.get(0, R0);
  if (isnan(R0) || R0 <= 0) {
    Serial.println("WARNING: No valid R0 in EEPROM. Using R0_DEFAULT.");
    R0 = R0_DEFAULT;
  }
  Serial.printf("Using R0: %.4f\n", R0);

  connectWiFi();

  lastSampleTime = millis();
  lastSendTime   = millis();
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost. Reconnecting...");
    WiFi.disconnect();
    connectWiFi();  // Will turn orange then green again
  }

  unsigned long now = millis();

  // ── Sample every 5 seconds ──────────────────────────────────────────────────
  if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = now;

    float temp = dht.readTemperature();
    float hum  = dht.readHumidity();
    float Vout = analogRead(MQ135_PIN) * (VC / 4095.0f);
    float co2  = 0;

    if (Vout > 0) {
      float Rs = ((VC / Vout) - 1.0f) * RL;
      co2 = 116.6020682f * powf(Rs / R0, -2.769034857f);
    }

    if (!isnan(temp) && !isnan(hum)) {
      tempSum += temp;
      humSum  += hum;
      co2Sum  += co2;
      sampleCount++;

      Serial.printf("Sample #%d — Temp: %.2f°C | Hum: %.2f%% | CO2: %.2f ppm\n",
                    sampleCount, temp, hum, co2);
    } else {
      Serial.println("Bad DHT reading, skipping sample.");
    }
  }

  // ── Send 1-minute average ───────────────────────────────────────────────────
  if (now - lastSendTime >= SEND_INTERVAL_MS && sampleCount > 0) {
    lastSendTime = now;

    float avgTemp = tempSum / sampleCount;
    float avgHum  = humSum  / sampleCount;
    float avgCO2  = co2Sum  / sampleCount;

    Serial.printf("\n--- 1-min average (%d samples) ---\n", sampleCount);
    Serial.printf("Temp: %.2f°C | Hum: %.2f%% | CO2: %.2f ppm\n\n",
                  avgTemp, avgHum, avgCO2);

    sendData(avgTemp, avgHum, avgCO2);

    tempSum = humSum = co2Sum = 0;
    sampleCount = 0;
  }
}