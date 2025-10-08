const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const dotenv = require("dotenv");
dotenv.config();

const db = new sqlite3.Database(path.join(__dirname, process.env.DB_NAME), (err) => {
  if (err) {
    console.error("DB open error:", err.message);
    process.exit(1);
  } else {
    console.log("SQLite connected");
  }
});

function createUsersTable(callback) {
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      userid TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )`,
    (err) => {
      if (err) {
        console.error("Error creating users table:", err.message);
        callback(err);
      } else {
        console.log("Users table created or already exists");
        callback(null);
      }
    }
  );
}

function createTokensTable(callback) {
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userid TEXT NOT NULL,
      access TEXT,
      refresh TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error("Error creating tokens table:", err.message);
      callback(err);
    }
    else {
      console.log("Tokens table created or already exists");
      callback(null);
    }
  });
}

function createOrdersTable(callback) {
  db.run(
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userid TEXT NOT NULL,
      username TEXT NOT NULL,
      products TEXT NOT NULL,
      total REAL NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        console.error("Error creating orders table:", err.message);
        callback(err);
      } else {
        console.log("Orders table created or already exists");
        callback(null);
      }
    }
  );
}

try {
  db.serialize(() => {
    // Create all tables first
    createTokensTable((err) => {
      if (err) process.exit(1);
    });

    createUsersTable((err) => {
      if (err) process.exit(1);
    });

    createOrdersTable((err) => {
      if (err) process.exit(1);
    });

    db.run(
      `CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
      )`,
      (err) => {
        if (err) {
          console.error("Error creating admins table:", err.message);
          process.exit(1);
        } else {
          console.log("Admins table created or already exists");
        }
      }
    );

    const defaultUsername = process.env.ADMIN_USERNAME;
    const defaultPassword = process.env.ADMIN_PASSWORD;
    const saltRounds = 10;

    db.get(
      "SELECT * FROM admins WHERE username = ?",
      [defaultUsername],
      (err, row) => {
        if (err) {
          console.error("Error checking for default admin:", err.message);
          process.exit(1);
        }
        if (!row) {
          bcrypt.hash(defaultPassword, saltRounds, (err, hash) => {
            if (err) {
              console.error("Error hashing default password:", err.message);
              process.exit(1);
            }
            db.run(
              "INSERT INTO admins (username, password) VALUES (?, ?)",
              [defaultUsername, hash],
              (err) => {
                if (err) {
                  console.error("Error creating default admin:", err.message);
                  process.exit(1);
                } else {
                  console.log("Default admin created: username=admin, password=admin123");
                }
              }
            );
          });
        } else {
          console.log("Default admin already exists");
        }
      }
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        quantity INTEGER NOT NULL,
        image TEXT
      )`,
      (err) => {
        if (err) {
          console.error("Error creating products table:", err.message);
          process.exit(1);
        } else {
          console.log("Products table created or already exists");
        }
      }
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id)
      )`,
      (err) => {
        if (err) {
          console.error("Error creating sales table:", err.message);
          process.exit(1);
        } else {
          console.log("Sales table created or already exists");
        }
      }
    );
  });
} catch (err) {
  console.error("Database initialization error:", err.message);
  process.exit(1);
}

function getAllProducts(callback) {
  db.all("SELECT * FROM products", [], (err, rows) => {
    if (err) {
      console.error("Error fetching products:", err.message);
      return callback(err);
    }
    callback(null, rows);
  });
}

function updateProduct(id, name, price, quantity, image, callback) {
  const fields = [];
  const values = [];

  if (name !== null && name !== undefined) {
    fields.push("name = ?");
    values.push(name);
  }
  if (price !== null && price !== undefined) {
    fields.push("price = ?");
    values.push(price);
  }
  if (quantity !== null && quantity !== undefined) {
    fields.push("quantity = ?");
    values.push(quantity);
  }
  if (image !== null && image !== undefined) {
    fields.push("image = ?");
    values.push(image);
  }

  if (fields.length === 0) {
    return callback(new Error("No fields to update"));
  }

  const sql = `UPDATE products SET ${fields.join(", ")} WHERE id = ?`;
  values.push(id);

  db.run(sql, values, function (err) {
    if (err) {
      console.error(`Error updating product ${id}:`, err.message);
      return callback(err);
    }
    db.get("SELECT * FROM products WHERE id = ?", [id], callback);
  });
}

function placeOrder(orderProducts, callback) {
  db.serialize(() => {
    const stmtUpdate = db.prepare(
      "UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?"
    );
    const stmtSale = db.prepare(
      "INSERT INTO sales (product_id, quantity, created_at) VALUES (?, ?, ?)"
    );

    try {
      orderProducts.forEach((p) => {
        if (!p.failed) {
          stmtUpdate.run(p.quantity, p.id, p.quantity);
          stmtSale.run(p.id, p.quantity, new Date().toISOString());
        }
      });
      stmtUpdate.finalize();
      stmtSale.finalize();
      callback(null, { success: true });
    } catch (err) {
      console.error("Error placing order:", err.message);
      callback(err);
    }
  });
}

function getAdminByUsername(username, callback) {
  db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
    if (err) {
      console.error("Error fetching admin by username:", err.message);
      return callback(err);
    }
    callback(null, row);
  });
}

function getAdminById(id, callback) {
  db.get("SELECT * FROM admins WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("Error fetching admin by id:", err.message);
      return callback(err);
    }
    callback(null, row);
  });
}

function updateAdminPasswordAndUsername(id, newUsername, newPasswordHash, callback) {
  const sql = `UPDATE admins SET username = ?, password = ? WHERE id = ?`;
  db.run(sql, [newUsername, newPasswordHash, id], (err) => {
    if (err) {
      console.error("Error updating admin credentials:", err.message);
      return callback(err);
    }
    callback(null);
  });
}

function addUser(userid, name, callback) {
  db.run("INSERT OR IGNORE INTO users (userid, name) VALUES (?, ?)", [userid, name], (err) => {
    if (err) {
      console.error("Error adding user:", err.message);
      return callback(err);
    }
    callback(null);
  });
}

function getAllUsers(callback) {
  db.all("SELECT * FROM users", [], (err, rows) => {
    if (err) {
      console.error("Error fetching users:", err.message);
      return callback(err);
    }
    callback(null, rows);
  });
}

function getUserByUserid(userid, callback) {
  db.get("SELECT * FROM users WHERE userid = ?", [userid], (err, row) => {
    if (err) {
      console.error("Error fetching user by userid:", err.message);
      return callback(err);
    }
    callback(null, row);
  });
}

function saveOrderSummary(userid, username, products, total, callback) {
  db.run(
    "INSERT INTO orders (userid, username, products, total) VALUES (?, ?, ?, ?)",
    [userid, username, JSON.stringify(products), total],
    (err) => {
      if (err) {
        console.error("Error saving order summary:", err.message);
        return callback(err);
      }
      console.log("✅ Saved order summary for user:", userid);
      callback(null);
    }
  );
}

function deleteUser(userid, callback) {
  db.run("DELETE FROM users WHERE userid = ?", [userid], function (err) {
    if (err) {
      console.error(`Error deleting user ${userid}:`, err.message);
      return callback(err);
    }
    callback(null, this.changes);
  });
}

async function saveTokens(userid, accessToken, refreshToken) {
  db.run(
    `DELETE FROM tokens WHERE userid = ?`,
    [userid],
    () => {
      db.run(
        `INSERT INTO tokens (userid, access, refresh) VALUES (?, ?, ?)`,
        [userid, accessToken, refreshToken]
      );
    }
  );
}

async function loadTokens(userid) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT access, refresh FROM tokens WHERE userid = ?`, [userid], (err, row) => {
      if (row) {
        resolve([row.access, row.refresh]);
      } else {
        resolve([null, null]);
      }
    });
  });
}

module.exports = {
  getAllProducts,
  updateProduct,
  placeOrder,
  getAdminByUsername,
  getAdminById,
  updateAdminPasswordAndUsername,
  addUser,
  getAllUsers,
  getUserByUserid,
  saveOrderSummary,
  createUsersTable,
  createOrdersTable,
  deleteUser,
  saveTokens,
  loadTokens,
};