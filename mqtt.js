const mqtt = require("mqtt");
const { addUser } = require("./models");
const dotenv = require("dotenv");
const { checkCardBalance } = require("./utils");
dotenv.config();

let shelfStatus = { 1: true, 2: true, 3: true, 4: true, 5: true };
let lastHeartbeat = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };
// let shelfStatus = { 1: false, 2: false, 3: false, 4: false, 5: false };
// let lastHeartbeat = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
let cardData = null;

const client = mqtt.connect(
  `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`,
  {
    reconnectPeriod: 1000,
    clientId: `vending_${Math.random().toString(16).slice(3)}`,
    connectTimeout: 5000,
  }
);

// setInterval(() => {
//   const now = Date.now();
//   for (let shelf = 1; shelf <= 5; shelf++) {
//     if (now - lastHeartbeat[shelf] > 30000) {
//       if (shelfStatus[shelf]) {
//         shelfStatus[shelf] = false;
//         console.log(`❌ Shelf ${shelf} marked as Disconnected (no heartbeat)`);
//       }
//     }
//   }
// }, 5000);

client.on("connect", () => {
  console.log("✅ MQTT connected to broker");
  client.subscribe(process.env.MQTT_TOPIC_HEARTBIT, { qos: 1 }, (err) => {
    if (err)
      console.error("❌ Failed to subscribe to heartbit topics:", err.message);
    else console.log("📡 Subscribed to heartbit topics");
  });
  client.subscribe(process.env.MQTT_TOPIC_CARD, { qos: 1 }, (err) => {
    if (err) console.error("❌ Failed to subscribe to card/data:", err.message);
    else console.log("📡 Subscribed to card/data");
  });
});

client.on("error", (err) => {
  console.error("❌ MQTT connection error:", err.message);
});

// client.on("close", () => {
//   console.log("❌ MQTT connection closed, attempting to reconnect...");
//   for (let shelf = 1; shelf <= 5; shelf++) {
//     shelfStatus[shelf] = false;
//     console.log(`❌ Shelf ${shelf} marked as Disconnected (connection closed)`);
//   }
//   cardData = null;
// });

client.on("message", async (topic, message) => {
  try {
    console.log(`📥 Received MQTT message on ${topic}: ${message.toString()}`);
    if (topic.startsWith("vending/heartbit/")) {
      const shelf = parseInt(topic.split("/").pop());
      if (shelf >= 1 && shelf <= 5) {
        shelfStatus[shelf] = true;
        lastHeartbeat[shelf] = Date.now();
        console.log(`❤️ Heartbeat from shelf ${shelf}`);
      }
    } else if (topic === "card/data") {
      if (message.toString() == "Card removed") {
        cardData = null;
        console.log("🗑️ Card removed, cleared cardData");
      } else {
        const data = JSON.parse(message.toString());
        const cardBalance = 0;
        //  await checkCardBalance(data);
        if (
          typeof data.userid &&
          data.userid &&
          typeof data.username === "string" &&
          data.username 
        ) {
          cardData = {
            userid: data.userid,
            username: data.username,
            credit: cardBalance,
          };

          addUser(cardData.userid, cardData.username, (err) => {
            console.log(err);
            if (err) {
              console.error(
                "❌ Failed to add user from card data:",
                err.message
              );
            } else {
              console.log(
                "✅ User added/updated from card data:",
                cardData.userid
              );
            }
          });
          // setTimeout(() => {
          //   if (cardData && cardData.userid === data.userid) {
          //     cardData = null;
          //     console.log("🕒 Cleared cardData due to timeout");
          //   }
          // }, process.env.CARD_REMOVE_TIMEOUT || 30000);
        } else {
          console.warn("⚠️ Invalid card/data:", message.toString());
          cardData = null;
        }
      }
      client.publish(
        process.env.MQTT_TOPIC_CARD_RESPONSE,
        JSON.stringify(cardData),
        { qos: 1 },
        (err) => {
          if (err) {
            console.error("❌ Failed to publish card data:", err.message);
          } else {
            console.log("📤 Published card data:", JSON.stringify(cardData));
          }
        }
      );
    }
  } catch (err) {
    console.error("❌ Error in MQTT message handler:", err.message);
  }
});

function sendOrderMQTT(products, callback) {
  console.log("📦 Received order products:", products);
  
  if (!client.connected) {
    console.error("❌ MQTT client not connected");
    return callback(new Error("MQTT client not connected"), {
      successfulProducts: [],
      failedProducts: products.map((p) => ({ ...p, failed: true })),
      dispenseLogs: []
    });
  }

  const shelves = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const failedProducts = [];
  const dispenseLogs = []; // Track all dispense attempts

  products.forEach((p) => {
    const productIds = p.product_ids || [p.id];
    const quantities = p.quantities || [p.quantity];
    
    productIds.forEach((id, index) => {
      const quantity = quantities[index];
      if (quantity <= 0) return;
      
      let shelf;
      if (id >= 1 && id <= 4) shelf = 1;
      else if (id >= 5 && id <= 8) shelf = 2;
      else if (id >= 9 && id <= 16) shelf = 3;
      else if (id >= 17 && id <= 24) shelf = 4;
      else if (id >= 25 && id <= 32) shelf = 5;

      if (shelf && !shelfStatus[shelf]) {
        console.log(`❌ Shelf ${shelf} is disconnected for spring ID ${id}`);
        failedProducts.push({ id: p.id, quantity: p.quantity, failed: true });
        
        // Log failed dispense
        dispenseLogs.push({
          shelf_number: shelf,
          spring_id: id,
          product_name: p.name || 'Unknown',
          quantity: quantity,
          group_id: p.group_id,
          status: 'failed',
          reason: 'shelf_disconnected'
        });
      } else if (shelf) {
        shelves[shelf].push({ 
          id, 
          quantity, 
          originalId: p.id,
          name: p.name,
          group_id: p.group_id,
          message: `${id},${quantity}` 
        });
      }
    });
  });

  let successfulProducts = [];
  let shelfIndex = 5;

  function processShelves() {
    if (shelfIndex < 1) {
      console.log("✅ All shelves processed");
      return callback(null, { successfulProducts, failedProducts, dispenseLogs });
    }

    if (shelves[shelfIndex].length === 0) {
      shelfIndex--;
      return processShelves();
    }

    console.log(
      `📋 Processing shelf ${shelfIndex} with items:`,
      shelves[shelfIndex]
    );
    let itemIndex = 0;

    function processItem() {
      if (itemIndex >= shelves[shelfIndex].length) {
        shelfIndex--;
        return processShelves();
      }

      const item = shelves[shelfIndex][itemIndex];
      if (!client.connected || !shelfStatus[shelfIndex]) {
        console.log(
          `❌ Shelf ${shelfIndex} disconnected for item: ${item.message}`
        );
        failedProducts.push({
          id: item.originalId,
          quantity: item.quantity,
          failed: true,
        });

        // Log failed dispense
        dispenseLogs.push({
          shelf_number: shelfIndex,
          spring_id: item.id,
          product_name: item.name,
          quantity: item.quantity,
          group_id: item.group_id,
          status: 'failed',
          reason: 'shelf_connection_lost'
        });

        itemIndex++;
        return processItem();
      }

      console.log(
        `📤 Publishing to vending/shelf/${shelfIndex}: ${item.message}`
      );
      console.log(`   └─ Spring ID: ${item.id}, Product: ${item.name}, Quantity: ${item.quantity}, Group: ${item.group_id || 'None'}`);
      
      client.publish(
        `vending/shelf/${shelfIndex}`,
        item.message,
        { qos: 1 },
        (err) => {
          if (err) {
            console.error(
              `❌ Failed to publish to vending/shelf/${shelfIndex}:`,
              err.message
            );
            failedProducts.push({
              id: item.originalId,
              quantity: item.quantity,
              failed: true,
            });

            // Log failed dispense
            dispenseLogs.push({
              shelf_number: shelfIndex,
              spring_id: item.id,
              product_name: item.name,
              quantity: item.quantity,
              group_id: item.group_id,
              status: 'failed',
              reason: 'mqtt_publish_error'
            });
          } else {
            console.log(
              `✅ Published to vending/shelf/${shelfIndex}: ${item.message}`
            );
            console.log(`   └─ Dispensed from Spring ${item.id}`);
            
            // Check if this product is already in successfulProducts
            const existing = successfulProducts.find(p => p.id === item.originalId);
            if (existing) {
              existing.quantity += item.quantity;
            } else {
              successfulProducts.push({ 
                id: item.originalId, 
                quantity: item.quantity,
                product_ids: [item.id],
                quantities: [item.quantity]
              });
            }

            // Log successful dispense
            dispenseLogs.push({
              shelf_number: shelfIndex,
              spring_id: item.id,
              product_name: item.name,
              quantity: item.quantity,
              group_id: item.group_id,
              status: 'success'
            });
          }
          itemIndex++;
          setTimeout(processItem, 1000);
        }
      );
    }

    processItem();
  }

  processShelves();
}

// Update exports
module.exports = { sendOrderMQTT, getEsp32Status, getCardData };

function getEsp32Status() {
  return Object.values(shelfStatus).some((status) => status);
}

function getCardData() {
  return cardData;
}

module.exports = { sendOrderMQTT, getEsp32Status, getCardData };
