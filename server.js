const bcrypt = require("bcrypt");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
dotenv.config();

const {
  getAllProducts,
  updateProduct,
  placeOrder,
  getAdminByUsername,
  getAdminById,
  updateAdminPasswordAndUsername,
  createUsersTable,
  addUser,
  getAllUsers,
  getUserByUserid,
  createOrdersTable,
  saveOrderSummary,
  deleteUser,
} = require("./models");
const { sendOrderMQTT, getEsp32Status, getCardData } = require("./mqtt");
const { checkCardBalance, recordConsumption } = require("./utils");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Ensure public/images directory exists
const imageDir = path.join(__dirname, "public/images");
if (!fs.existsSync(imageDir)) {
  fs.mkdirSync(imageDir, { recursive: true });
  console.log("✅ Created public/images directory");
}
app.use("/images", express.static(path.join(__dirname, "public/images")));

async function authenticateAdmin(req, res, next) {
  const adminId = (req.body || {}).adminId || (req.query || {}).adminId;
  console.log(`Authenticating request: adminId=${adminId}, method=${req.method}, url=${req.url}, body=${JSON.stringify(req.body)}, query=${JSON.stringify(req.query)}`);
  if (!adminId) {
    console.log("Authentication failed: No adminId provided");
    return res.status(401).json({ error: "Unauthorized: No adminId provided" });
  }

  try {
    const admin = await new Promise((resolve, reject) => {
      getAdminById(adminId, (err, row) => {
        if (err) {
          console.error(`Error fetching admin for adminId=${adminId}:`, err.message);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
    if (!admin) {
      console.log(`Authentication failed: No admin found for adminId=${adminId}`);
      return res.status(401).json({ error: "Unauthorized: Invalid adminId" });
    }
    req.admin = admin;
    next();
  } catch (err) {
    console.error("Authentication error:", err.message);
    res.status(500).json({ error: `Server error during authentication: ${err.message}` });
  }
}

app.get("/api/products", (req, res) => {
  getAllProducts((err, rows) => {
    if (err) {
      console.error("Error fetching products:", err.message);
      res.status(500).json({ error: `Failed to fetch products: ${err.message}` });
    } else {
      console.log(`Fetched ${rows.length} products`);
      res.json(rows);
    }
  });
});

app.put("/api/products/:id", authenticateAdmin, (req, res) => {
  const { id } = req.params;
  const { name, price, quantity } = req.body;
  console.log(`PUT /api/products/${id}: name=${name}, price=${price}, quantity=${quantity}`);

  updateProduct(id, name, price, quantity, null, (err) => {
    if (err) {
      console.error(`Error updating product ${id}:`, err.message);
      res.status(500).json({ success: false, message: `Failed to update product: ${err.message}` });
    } else {
      console.log(`✅ Updated product ${id}`);
      res.json({ success: true, message: "Product updated" });
    }
  });
});

app.post("/api/order", async(req, res) => {
  const orderProducts = req.body.products;
  console.log("POST /api/order received:", orderProducts);
  if (!orderProducts || !Array.isArray(orderProducts) || orderProducts.length === 0) {
    console.log("Order failed: Invalid or empty products array");
    return res.status(400).json({ error: "Invalid or empty products array" });
  }

  const cardData = await getCardData();
  if (!cardData) {
    console.log("Order failed: No card data");
    return res.status(400).json({ error: "Please insert the card for checkout" });
  }

  const { userid, username, credit } = cardData;

  //check credit from api not card
 const cardBalance =  await checkCardBalance(cardData);

  if (!userid ||  cardBalance <= 0) {
    console.log("Order failed: Invalid card data:", cardBalance);
    return res.status(400).json({ error: "Invalid user card or Balance Low!" });
  }

  getUserByUserid(userid, (err, user) => {
    if (err || !user ) {
      console.log("Order failed: Card data does not match any user:", cardData);
      return res.status(400).json({ error: "Invalid user! " });
    }

    getAllProducts((err, allProducts) => {
      if (err) {
        console.error("Error fetching products for order:", err.message);
        return res.status(500).json({ error: `Failed to fetch products: ${err.message}` });
      }

      let total = 0;
      const validProducts = orderProducts.map((p) => {
        const product = allProducts.find((prod) => prod.id === p.id);
        if (!product || product.quantity < p.quantity) {
          return { ...p, failed: true };
        }
        total += product.price * p.quantity;
        return p;
      });

      if (cardBalance < total) {
        console.log("Order failed: Insufficient cardBalance:", { cardBalance, total });
        return res.status(400).json({ error: "Insufficient cardBalance" });
      }

      sendOrderMQTT(validProducts, (err, result) => {
        if (err) {
          console.error("Order error:", err.message);
          return res.status(500).json({ error: `Order failed: ${err.message}` });
        }

        const { successfulProducts, failedProducts } = result;
        console.log("Order processed:", { successfulProducts, failedProducts });

        placeOrder(successfulProducts, (err) => {
          if (err) {
            console.error("Database error:", err.message);
            return res.status(500).json({ error: `Database error: ${err.message}` });
          }

          const cart = orderProducts.map((p) => ({
            ...p,
            failed: failedProducts.some((fp) => fp.id === p.id),
            name: allProducts.find((prod) => prod.id === p.id)?.name || "Unknown",
            image: allProducts.find((prod) => prod.id === p.id)?.image || "/images/fallback.jpg",
          }));

          saveOrderSummary(userid, username, orderProducts, total, (err) => {
            if (err) {
              console.error("Error saving order summary:", err.message);
              return res.status(500).json({ error: `Failed to save order summary: ${err.message}` });
            }

            // Record consumption only if ESP32 is connected
            if(getEsp32Status()){ 
              recordConsumption(cardData, total).catch((err) => {
                console.error("Error recording consumption:", err.message);
              });
            }
         
            console.log("Order placed successfully:", cart);
            res.json({ success: true, message: "Order processed", cart });
          });
        });
      });
    });
  });
});

const imagePath = path.join(__dirname, process.env.IMAGE_UPLOAD_PATH);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imagePath),
  filename: (req, file, cb) => {
    const { id } = req.params;
    const ext = path.extname(file.originalname).toLowerCase();
    const newFilename = `product${id}${ext}`;
    const filePath = path.join(imagePath, newFilename);
    // Delete existing image with the same name, if it exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Deleted existing image: ${filePath}`);
    }
    cb(null, newFilename);
  },
});
const upload = multer({ storage });

app.post("/api/products/:id/image", upload.single("image"), (req, res, next) => {
  console.log(`POST /api/products/${req.params.id}/image: Processing FormData, file=${req.file?.filename || "none"}, body=${JSON.stringify(req.body)}`);
  next();
}, authenticateAdmin, (req, res) => {
  const { id } = req.params;
  console.log(`POST /api/products/${id}/image: file=${req.file?.filename || "none"}, body=${JSON.stringify(req.body)}, adminId=${req.body.adminId || req.query.adminId}`);
  if (!req.file) {
    console.error(`Error updating product image ${id}: No file uploaded`);
    return res.status(400).json({ success: false, message: "No image provided" });
  }
  const image = `/images/${req.file.filename}`;

  updateProduct(id, null, null, null, image, (err) => {
    if (err) {
      console.error(`Error updating product image ${id}:`, err.message);
      res.status(500).json({ success: false, message: `Failed to update product image: ${err.message}` });
    } else {
      console.log(`✅ Updated image for product ${id}: ${image}`);
      res.json({ success: true, message: "Image updated", image });
    }
  });
});

app.get("/api/card-data", (req, res) => {
  const cardData = getCardData();
  console.log("📋 Sending card data:", cardData || "No card data");
  res.json(cardData || { error: "Card is not inserted or data is missing" });
});

app.get("/api/users", authenticateAdmin, (req, res) => {
  console.log("GET /api/users received");
  getAllUsers((err, rows) => {
    if (err) {
      console.error("Error fetching users:", err.message);
      res.status(500).json({ error: `Failed to fetch users: ${err.message}` });
    } else {
      console.log(`✅ Fetched ${rows.length} users`);
      res.json(rows);
    }
  });
});

app.post("/api/users", authenticateAdmin, (req, res) => {
  const { userid, name } = req.body;
  console.log(`POST /api/users: userid=${userid}, name=${name}`);
  if (!userid || !name) {
    console.log("Add user failed: Missing userid or name");
    return res.status(400).json({ error: "Missing userid or name" });
  }

  addUser(userid, name, (err) => {
    if (err) {
      console.error("Error adding user:", err.message);
      if (err.message.includes("SQLITE_CONSTRAINT: UNIQUE constraint failed")) {
        return res.status(400).json({ error: "User ID already exists" });
      }
      res.status(500).json({ error: `Failed to add user: ${err.message}` });
    } else {
      console.log(`✅ Added user ${userid}`);
      res.json({ success: true, message: "User added" });
    }
  });
});

app.delete("/api/users/:userid", authenticateAdmin, (req, res) => {
  const { userid } = req.params;
  console.log(`DELETE /api/users/${userid}`);
  deleteUser(userid, (err, changes) => {
    if (err) {
      console.error(`Error deleting user ${userid}:`, err.message);
      res.status(500).json({ error: `Failed to delete user: ${err.message}` });
    } else if (changes === 0) {
      console.log(`Delete user failed: No user found for userid=${userid}`);
      res.status(404).json({ error: "User not found" });
    } else {
      console.log(`✅ Deleted user ${userid}`);
      res.json({ success: true, message: "User deleted" });
    }
  });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  console.log(`POST /api/login: username=${username}`);
  if (!username || !password) {
    console.log("Login failed: Missing username or password");
    return res.status(400).json({ success: false, message: "Username and password are required" });
  }

  try {
    const admin = await new Promise((resolve, reject) => {
      getAdminByUsername(username, (err, row) => {
        if (err) reject(err);
        if (!row) return resolve(false);
        bcrypt.compare(password, row.password, (err, match) => {
          if (err) reject(err);
          if (match) resolve(row);
          else resolve(false);
        });
      });
    });

    if (!admin) {
      console.log("Login failed: Invalid username or password");
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    console.log(`✅ Login successful for username=${username}, adminId=${admin.id}`);
    res.json({
      success: true,
      message: "Login successful",
      adminId: admin.id,
      username: admin.username,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ success: false, message: `Server error during login: ${err.message}` });
  }
});

app.put("/api/admin", authenticateAdmin, async (req, res) => {
  const { currentPassword, newUsername, newPassword, adminId } = req.body;
  console.log(`PUT /api/admin: adminId=${adminId}, newUsername=${newUsername}, hasNewPassword=${!!newPassword}`);

  try {
    const admin = await new Promise((resolve, reject) => {
      getAdminById(adminId, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!admin) {
      console.log(`Admin update failed: No admin found for adminId: ${adminId}`);
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    const valid = await bcrypt.compare(currentPassword, admin.password);
    if (!valid) {
      console.log(`Admin update failed: Incorrect current password for adminId: ${adminId}`);
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    const hashedPassword = newPassword ? await bcrypt.hash(newPassword, 10) : admin.password;
    const updatedUsername = newUsername || admin.username;

    updateAdminPasswordAndUsername(adminId, updatedUsername, hashedPassword, (err) => {
      if (err) {
        console.error("Admin update error:", err.message);
        res.status(500).json({ success: false, message: `Failed to update admin credentials: ${err.message}` });
      } else {
        console.log(`✅ Admin credentials updated for adminId: ${adminId}`);
        res.json({ success: true, message: "Admin credentials updated successfully" });
      }
    });
  } catch (err) {
    console.error("Admin update error:", err.message);
    res.status(500).json({ success: false, message: `Failed to update admin credentials: ${err.message}` });
  }
});

app.get("/api/esp32-status", (req, res) => {
  console.log("GET /api/esp32-status");
  res.json({ connected: getEsp32Status() });
});

app.listen(process.env.PORT || 5001, () => {
  console.log(`Server running on PORT ${process.env.PORT || 5001}`);
  createUsersTable((err) => {
    if (err) console.error("Error creating users table:", err.message);
    else console.log("✅ Users table created");
  });
  createOrdersTable((err) => {
    if (err) console.error("Error creating orders table:", err.message);
    else console.log("✅ Orders table created");
  });
});