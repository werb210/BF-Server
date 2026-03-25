const axios = require("axios")

async function run() {
  const res = await axios.get("http://localhost:3000/debug/routes")
  console.log(JSON.stringify(res.data, null, 2))
}

run()
