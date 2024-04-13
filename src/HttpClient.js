import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class HttpClient {
  constructor({ username, password, hostname, headers }) {
    this.username = username;
    this.password = password;
    this.hostname = hostname;
    this.headers = headers;
    this.tokenDate = 0;
    this.tokenPath = `${__dirname}/temp/jwt.txt`;
    this.loginCount = 0;
  }
  tokenLife = 7.2e6;

  addRoutes = (routes) => {
    for (const { name, path, methods, params: defaultParams = [] } of routes) {
      if (name in this) {
        throw new Error(`Property "${name}" already exist. Specify a different route name`);
      }
      this[name] = methods.reduce((acc, method) => {
        acc[method.toLowerCase()] = ({ referrer, body, headers, params: userParams = [], logEvent }) =>
          this.run({
            pathname: path,
            referrer,
            headers,
            body,
            params: defaultParams.concat(userParams),
            method,
            logEvent,
          });
        return acc;
      }, {});
    }
  };

  login = async () => {
    const headers = {
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
      "x-version": "2435.8",
    };

    const { code } = await this.run({
      pathname: "/api/v1/auth/login",
      method: "POST",
      body: {
        name: this.username,
        password: this.password,
        w: "1920:1080",
        mobileOptimizations: true,
      },
      headers,
      logEvent: "login",
    })
      .then((res) => {
        return res.json();
      })
      .catch((error) => {
        fs.writeFileSync(`${__dirname}/logs/error.txt`, JSON.stringify(error));
        console.log("Failed to login: ", error.message);
        throw error;
      });

    const token = await this.run({
      pathname: "/api/v1/auth",
      method: "GET",
      params: [["code", code]],
      headers,
      logEvent: "auth",
    })
      .then((res) => {
        const cookies = res.headers.get("Set-Cookie");
        const token = cookies.substring(4, cookies.indexOf(";"));
        this.loginCount++;
        fs.writeFileSync(`${__dirname}/logs/login-count.txt`, JSON.stringify(this.loginCount));
        return token;
      })
      .catch((error) => {
        fs.writeFileSync(`${__dirname}/logs/error.txt`, JSON.stringify(error));
        console.log("Failed to auth: ", error.message);
        throw error;
      });

    const date = Date.now();
    fs.writeFileSync(this.tokenPath, JSON.stringify({ token, date }), "utf8");
    this.headers.cookie = `JWT=${token}; SameSite=None; Secure`;
    return true;
  };

  run = async ({ retry, pathname = "/", referrer = "/", body, method, headers = {}, params = [], logEvent = "" }) => {
    const now = Date.now();

    if (now - this.tokenDate > this.tokenLife) {
      try {
        const jwt = fs.readFileSync(this.tokenPath, "utf8");

        if (jwt) {
          const { token, date = 0 } = JSON.parse(jwt) || {};

          if (Date.now() - date < this.tokenLife) {
            this.headers.cookie = `JWT=${token}; SameSite=None; Secure`;
            this.tokenDate = date;
          } else throw new Error("Token expired");
        }
      } catch (error) {
        console.log(error.message);
        this.tokenDate = now;
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

    logEvent && console.log(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] ${logEvent}: ${url}`);
    try {
      const res = await fetch(url, config);

      const jwt = res.headers.get("Set-Cookie");
      if (jwt) {
        const parts = jwt.split(".");
        const decodedPayload = Buffer.from(parts[1], "base64").toString("utf-8");
        const payload = JSON.parse(decodedPayload);
        const { did } = payload.properties;
        console.log(`--- ${pathname} ${did}`);
      } else console.log(`--- ${pathname} null`);

      if (res.status === 400) {
        console.log(config);
        count = 3;
        throw new Error(`HTTP error! Status: ${res.status}, ${res.statusText}`);
      }

      if (res.status === 401) {
        this.tokenDate = now;
        await this.login();
        retry.headers.cookie = this.headers.cookie;
        throw new Error(`HTTP error! Status: ${res.status}, ${res.statusText}. Duration: ${now - this.tokenDate}`);
      }

      if (!res.ok) throw new Error(`HTTP error! Status: ${res.status}, ${res.statusText}`);

      return res;
    } catch (error) {
      if (count < 2) return this.run({ retry: { url, config, count }, logEvent: "retry" });
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
