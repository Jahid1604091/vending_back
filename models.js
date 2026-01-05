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

          //add group_id
          db.run(`ALTER TABLE products ADD COLUMN group_id INTEGER`,
            (err)=>{
              if(err){
                if(err.message.includes("duplicate column name")){
                  console.log('group_id already exists')
                }
                else{
                  console.error("Error adding group_id ",err.message)
                }
              }
              else{
                console.log('group_id added to products table')
              }
            }
          )
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

    db.run(
  `CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT
  )`,
  (err) => {
    if (err) {
      console.error("Error creating groups table:", err.message);
      process.exit(1);
    } else {
      console.log("Groups table created or already exists");
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

function getProductsGrouped(callback) {
  const sql = `
    SELECT 
      COALESCE(group_id, id) as display_id,
      CASE 
        WHEN group_id IS NOT NULL THEN group_id
        ELSE id
      END as group_key,
      group_id,
      -- Pick the first product's details as representative
      MIN(name) as name,
      MIN(price) as price,
      MIN(image) as image,
      -- Sum all quantities in the group
      SUM(quantity) as quantity,
      -- Collect all product IDs in the group
      GROUP_CONCAT(id) as product_ids
    FROM products
    GROUP BY 
      CASE 
        WHEN group_id IS NOT NULL THEN group_id
        ELSE id
      END
    ORDER BY display_id
  `;
  
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Error fetching grouped products:", err.message);
      return callback(err);
    }
    // Convert product_ids string to array of integers
    const result = rows.map(row => ({
      ...row,
      product_ids: row.product_ids.split(',').map(id => parseInt(id))
    }));
    callback(null, result);
  });
}

function updateProduct(id, name, price, quantity, image, group_id, callback) {
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
  if (group_id !== null && group_id !== undefined) {
    fields.push("group_id = ?");
    values.push(group_id);
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
        if (!p.failed && p.product_ids && p.product_ids.length > 0) {
          // Distribute quantity across grouped products
          let remainingQty = p.quantity;
          
          p.product_ids.forEach((productId, index) => {
            if (remainingQty > 0) {
              const qtyToDeduct = Math.min(remainingQty, p.quantities[index] || remainingQty);
              stmtUpdate.run(qtyToDeduct, productId, qtyToDeduct);
              stmtSale.run(productId, qtyToDeduct, new Date().toISOString());
              remainingQty -= qtyToDeduct;
            }
          });
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

function getAllGroups(callback) {
  db.all("SELECT * FROM groups", [], (err, rows) => {
    if (err) {
      console.error("Error fetching groups:", err.message);
      return callback(err);
    }
    callback(null, rows);
  });
}

function getGroupById(id, callback) {
  db.get("SELECT * FROM groups WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("Error fetching group by id:", err.message);
      return callback(err);
    }
    callback(null, row);
  });
}

function createGroup(name, description, callback) {
  db.run(
    "INSERT INTO groups (name, description) VALUES (?, ?)",
    [name, description],
    function (err) {
      if (err) {
        console.error("Error creating group:", err.message);
        return callback(err);
      }
      db.get("SELECT * FROM groups WHERE id = ?", [this.lastID], callback);
    }
  );
}

function updateGroup(id, name, description, callback) {
  const fields = [];
  const values = [];

  if (name !== null && name !== undefined) {
    fields.push("name = ?");
    values.push(name);
  }
  if (description !== null && description !== undefined) {
    fields.push("description = ?");
    values.push(description);
  }

  if (fields.length === 0) {
    return callback(new Error("No fields to update"));
  }

  const sql = `UPDATE groups SET ${fields.join(", ")} WHERE id = ?`;
  values.push(id);

  db.run(sql, values, function (err) {
    if (err) {
      console.error(`Error updating group ${id}:`, err.message);
      return callback(err);
    }
    db.get("SELECT * FROM groups WHERE id = ?", [id], callback);
  });
}

function deleteGroup(id, callback) {
  db.run("DELETE FROM groups WHERE id = ?", [id], function (err) {
    if (err) {
      console.error(`Error deleting group ${id}:`, err.message);
      return callback(err);
    }
    callback(null, this.changes);
  });
}
function getAllProductsUngrouped(callback) {
  db.all("SELECT * FROM products ORDER BY id", [], (err, rows) => {
    if (err) {
      console.error("Error fetching ungrouped products:", err.message);
      return callback(err);
    }
    callback(null, rows);
  });
}

// Get all products for a specific group
function getProductsByGroupId(groupId, callback) {
  db.all(
    "SELECT * FROM products WHERE group_id = ? ORDER BY id",
    [groupId],
    (err, rows) => {
      if (err) {
        console.error("Error fetching products by group:", err.message);
        return callback(err);
      }
      callback(null, rows);
    }
  );
}

// Assign products to a group
function assignProductsToGroup(productIds, groupId, callback) {
  const placeholders = productIds.map(() => '?').join(',');
  const sql = `UPDATE products SET group_id = ? WHERE id IN (${placeholders})`;
  
  db.run(sql, [groupId, ...productIds], function(err) {
    if (err) {
      console.error("Error assigning products to group:", err.message);
      return callback(err);
    }
    callback(null, this.changes);
  });
}

// Remove products from group
function removeProductsFromGroup(productIds, callback) {
  const placeholders = productIds.map(() => '?').join(',');
  const sql = `UPDATE products SET group_id = NULL WHERE id IN (${placeholders})`;
  
  db.run(sql, productIds, function(err) {
    if (err) {
      console.error("Error removing products from group:", err.message);
      return callback(err);
    }
    callback(null, this.changes);
  });
}

// Bulk update products in a group (name, price)
function bulkUpdateGroupProducts(productIds, updates, callback) {
  const { name, price } = updates;
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

  if (fields.length === 0) {
    return callback(new Error("No fields to update"));
  }

  const placeholders = productIds.map(() => '?').join(',');
  const sql = `UPDATE products SET ${fields.join(", ")} WHERE id IN (${placeholders})`;
  
  db.run(sql, [...values, ...productIds], function(err) {
    if (err) {
      console.error("Error bulk updating products:", err.message);
      return callback(err);
    }
    callback(null, this.changes);
  });
}

// Add this function
function getSpringsByIds(productIds, callback) {
  const placeholders = productIds.map(() => '?').join(',');
  const sql = `SELECT id, name, quantity, price, image, group_id FROM products WHERE id IN (${placeholders}) ORDER BY id`;
  
  db.all(sql, productIds, (err, rows) => {
    if (err) {
      console.error("Error fetching springs by IDs:", err.message);
      return callback(err);
    }
    callback(null, rows);
  });
}

// Smart distribution: prioritize springs with stock, skip empty ones
async function smartDistributeQuantity(orderedQty, productIds) {
  return new Promise((resolve, reject) => {
    // Get actual stock for each spring in the group
    const placeholders = productIds.map(() => '?').join(',');
    const sql = `SELECT id, quantity FROM products WHERE id IN (${placeholders}) ORDER BY id`;
    
    db.all(sql, productIds, (err, springs) => {
      if (err) {
        console.error("Error fetching spring stock:", err.message);
        return reject(err);
      }

      const distribution = [];
      let remaining = orderedQty;

      // Distribute across springs in order, prioritizing those with stock
      for (const spring of springs) {
        if (remaining <= 0) break;
        
        if (spring.quantity > 0) {
          const takeFromThisSpring = Math.min(remaining, spring.quantity);
          distribution.push({
            spring_id: spring.id,
            quantity: takeFromThisSpring,
            available: spring.quantity
          });
          remaining -= takeFromThisSpring;
          console.log(`📊 Smart distribution: Spring ${spring.id} → ${takeFromThisSpring} items (${spring.quantity} available)`);
        } else {
          console.log(`⚠️ Skipping Spring ${spring.id} - Out of stock`);
        }
      }

      if (remaining > 0) {
        console.warn(`⚠️ Could not fulfill full order. Short by ${remaining} items`);
      }

      resolve(distribution);
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
  getAllGroups,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
  getProductsGrouped,
  getAllProductsUngrouped,
   getProductsByGroupId,        
  assignProductsToGroup,        
  removeProductsFromGroup,      
  bulkUpdateGroupProducts,      
  getSpringsByIds,
  smartDistributeQuantity
};