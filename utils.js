const axios = require("axios");
const dotenv = require("dotenv");
const { loadTokens, saveTokens } = require("./models");
dotenv.config();

let accessToken = null;
let refreshToken = null;

// Login to get initial tokens
async function login(userid) {
  const res = await axios.post(process.env.TOKEN_API, {
    username: process.env.VU_USERNAME,
    password: process.env.VU_PASSWORD,
  });

  accessToken = res.data.access;
  refreshToken = res.data.refresh;
  await saveTokens(userid, accessToken, refreshToken);
  return { accessToken, refreshToken };
}

// Refresh access token
async function refreshAccessToken(userid) {
  if (!refreshToken) {
    console.log("No refresh token, re-login required");
    throw new Error("No refresh token available");
  }
  console.log(`*****Calling Refresh API******`);

  try {
    const res = await axios.post(process.env.REFRESH_TOKEN_API, {
      refresh: refreshToken,
    });
  
    accessToken = res.data.access;
    await saveTokens(userid, accessToken, refreshToken);
    return accessToken;
    
  } catch (error) {
    console.log('Refresh token expired, re-login');
    await login(userid);

    await loadTokens(userid).then(([a,r])=> {
      accessToken = a;
      refreshToken = r;
    });

    return accessToken;
  }
}

// Wrapper for authenticated requests
async function authRequest(url, options = {}, retry = true) {
  await loadTokens(options.userid).then(([a, r]) => {
    accessToken = a;
    refreshToken = r;
  });

  try {
    if (!accessToken) {
      //calling Login api if no access token found
      console.log("No access token, logging in...",options.userid);
      await login(options.userid);
      await loadTokens(options.userid).then(([a, r]) => {
        accessToken = a;
        refreshToken = r;
      });
    }

    const res = await axios({
      url,
      method: options.method || "GET",
      headers: {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
      },
      data: options.data || undefined,
      params: options.params || undefined,
    });

    return res;
  } catch (err) {
    if (err.response?.status === 401 && retry) {
      console.log("Access token expired, refreshing...");
      await refreshAccessToken(options.userid);
      await loadTokens(options.userid).then(([a, r]) => {
        accessToken = a;
        refreshToken = r;
      });
      return authRequest(url, options, false); 
    }
    throw err;
  }
}

// Check card balance
async function checkCardBalance(cardData) {
  if (!cardData) {
    console.log("Order failed: No card data");
    return 0;
  }

  try {
    const { data } = await authRequest(
      `${process.env.BALANCE_CHECK_API}${cardData.userid}/balance/`,
      { userid: cardData.userid }
    );
    return data.balance || 0;
  } catch (err) {
    console.error("Balance check failed:", err.response?.data || err.message);
    return 0;
    // return res.status(500).json({ error: "Unable to check balance" });
  }
}

// Record consumption
async function recordConsumption(cardData, amount) {
  if (!cardData) {
    throw new Error("No card data for recording consumption");
  }
  try {
    const res = await authRequest(`${process.env.CONSUMPTION_API}`, {
      userid:cardData.userid,
      method: "POST",
      data: {
        reference: cardData.userid,
        cost: amount,
        service: 3,
      },
    });

    console.log(`Consumption recorded successfully:`, res.data);
  } catch (err) {
    console.error("Failed to record consumption:", err.message);
  }
}

module.exports = {
  authRequest,
  login,
  refreshAccessToken,
  checkCardBalance,
  recordConsumption,
};
