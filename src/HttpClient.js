import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class HttpClient {
  constructor({ username, password, hostname }) {
    this.headers = {
      accept: "application/json, text/javascript, */*; q=0.01",
      "accept-language": "en-US,en;q=0.9,he-IL;q=0.8,he;q=0.7,ru-RU;q=0.6,ru;q=0.5",
      "content-type": "application/json; charset=UTF-8",
      "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-requested-with": "XMLHttpRequest",
    };
    this.username = username;
    this.password = password;
    this.hostname = hostname;
    this.tokenPath = `${__dirname}/temp/jwt.json`;
    this.loginCount = 0;
    this.tokens = { 0: { exp: 0, token: "" } };
    this.activeVillage = 0;
  }

  setHeader = (key, value) => (this.headers[key] = value);

  addRoutes = (routes) => {
    for (const { name, path, methods, params: defaultParams = [] } of routes) {
      if (name in this) {
        throw new Error(`Property "${name}" already exist. Specify a different route name`);
      }
      this[name] = methods.reduce((acc, method) => {
        acc[method.toLowerCase()] = ({ referrer, body, villageId, headers, params: userParams = [], logEvent }) =>
          this.run({
            pathname: path,
            referrer,
            headers,
            body,
            villageId,
            params: defaultParams.concat(userParams),
            method,
            logEvent,
          });
        return acc;
      }, {});
    }
  };

  setVillage = async (newVillageId) => {
    const now = Math.floor(Date.now() / 1000);
    const villageToken = this.tokens[newVillageId];
    if (!villageToken || now >= villageToken.exp) {
      await this.run({
        pathname: "/api/v1/village/change-current",
        method: "POST",
        body: { newVillageId },
        logEvent: "Change Village",
      });
    }
    return newVillageId;
  };

  login = async () => {
    let code = 0;

    try {
      const res = await this.run({
        pathname: "/api/v1/auth/login",
        method: "POST",
        body: {
          name: this.username,
          password: this.password,
          w: "1920:1080",
          mobileOptimizations: true,
        },
        logEvent: "login",
      });
      const data = await res.json();
      code = data.code;
    } catch (error) {
      fs.writeFileSync(`${__dirname}/logs/error.txt`, JSON.stringify(error));
      console.log("Failed to login: ", error.message);
      throw error;
    }

    try {
      await this.run({
        pathname: "/api/v1/auth",
        method: "GET",
        params: [["code", code]],
        logEvent: "auth",
      });

      this.loginCount++;
      fs.writeFileSync(`${__dirname}/logs/login-count.txt`, JSON.stringify(this.loginCount));
      return true;
    } catch (error) {
      fs.writeFileSync(`${__dirname}/logs/error.txt`, JSON.stringify(error));
      console.log("Failed to auth: ", error.message);
      throw error;
    }
  };

  run = async ({
    retry,
    pathname = "/",
    referrer = "/",
    body,
    method,
    headers = {},
    params = [],
    villageId,
    logEvent = "",
  }) => {
    const activeVillage = villageId ? await this.setVillage(villageId) : this.activeVillage;
    const now = Math.floor(Date.now() / 1000);
    const villageToken = this.tokens[activeVillage];

    if (!villageToken) {
      console.log(villageId, activeVillage);
      console.log(this.tokens);
      return;
    }

    if (villageToken.exp <= now) {
      try {
        const jwt = fs.readFileSync(this.tokenPath, "utf8");

        if (jwt) {
          const cache = JSON.parse(jwt) || { exp: 0 };
          Object.assign(villageToken, cache);
          if (villageToken.exp <= now) throw new Error("Cached token expired");
        }
      } catch (error) {
        console.log(error.message);
        villageToken.exp = now + 10;
        await this.login();
      }
    }

    let count = retry ? ++retry.count : 0;
    const paramString = params.reduce((acc, [key, val]) => (acc += `${key}=${val}&`), "?").slice(0, -1);
    const url = retry ? retry.url : `https://${this.hostname + pathname + paramString}`;

    const config = retry
      ? retry.config
      : {
          headers: { ...this.headers, ...headers },
          referrer: `https://${this.hostname + referrer}`,
          referrerPolicy: "strict-origin-when-cross-origin",
          body: body ? (typeof body === "object" ? JSON.stringify(body) : body) : null,
          method,
          mode: "cors",
          credentials: "include",
        };

    config.headers.cookie = `JWT=${villageToken.token}; SameSite=None; Secure`;

    logEvent && console.log(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] ${logEvent}: ${url}`);
    try {
      const res = await fetch(url, config);

      const cookie = res.headers.get("Set-Cookie");
      if (cookie) {
        const token = cookie.substring(4, cookie.indexOf(";"));
        const parts = token.split(".");
        const decodedPayload = Buffer.from(parts[1], "base64").toString("utf-8");
        const { properties, exp } = JSON.parse(decodedPayload);
        fs.writeFileSync(this.tokenPath, JSON.stringify({ token, exp }), "utf8");
        const { did = 0 } = properties;
        this.tokens[did] = {
          token,
          exp,
        };
        this.activeVillage = did;
        console.log("Set active village: ", did, url);
      } else {
        console.log("no cookie: ", cookie, url);
      }

      if (res.status === 400) {
        console.log(config);
        count = 3;
        throw new Error(`HTTP error! Status: ${res.status}, ${res.statusText}`);
      }

      if (res.status === 401) {
        villageToken.exp = now + 10;
        await this.login();
        throw new Error(`HTTP error! Status: ${res.status}, ${res.statusText}`);
      }

      if (!res.ok) throw new Error(`HTTP error! Status: ${res.status}, ${res.statusText}`);

      return res;
    } catch (error) {
      if (count < 2) return this.run({ retry: { url, config, count }, villageId, logEvent: "retry" });
      else throw error;
    }
  };

  graphql = async ({ query, fragments, variables, callbackArray = [], logEvent }) => {
    const body = { query };
    fragments && (body.fragments = fragments);
    variables && (body.variables = variables);

    try {
      const res = await this.run({
        pathname: "/api/v1/graphql",
        referrer: "/dorf1.php",
        body,
        method: "POST",
        logEvent,
      });
      const { data } = await res.json();
      callbackArray.forEach((cb) => cb(data));
      return data;
    } catch (error) {
      console.log("graphql: ", error.message);
      fs.writeFileSync(`${__dirname}/logs/error.txt`, JSON.stringify(error));
      return null;
    }
  };
}

export default HttpClient;
