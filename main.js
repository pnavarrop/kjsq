const kafka = require("kafka-node"),
  express = require("express"),
  bodyParser = require("body-parser"),
  { uuid } = require("uuidv4");

const app = express();
app.use(bodyParser.json());
app.use("/", express.static("web"));

class Publisher {
  constructor(kafkaHost, topic) {
    this.kafkaHost = kafkaHost;
    this.topic = topic;
  }

  init() {
    this.producer = new kafka.Producer(
      new kafka.KafkaClient({ kafkaHost: this.kafkaHost }),
      {
        // Configuration for when to consider a message as acknowledged
        requireAcks: 1,
        // The amount of time in milliseconds to wait for all acks
        ackTimeoutMs: 100,
        // Partitioner type (default = 0, random = 1, cyclic = 2, keyed = 3, custom = 4)
        partitionerType: 3,
      }
    );
    return new Promise((resolve, reject) => {
      this.producer.on("ready", resolve);
      this.producer.on("error", reject);
    });
  }

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!msg) {
        reject("message cannot be empty");
        return;
      }
      if (!(typeof msg === "object" || typeof msg === "string")) {
        reject("messages can only be objects or strings");
        return;
      }
      if (msg.key && !msg.payload) {
        reject("payload is required if 'key' is present");
        return;
      }
      this.producer.send(
        [
          {
            topic: this.topic,
            messages: [msg.payload ? msg.payload : msg],
            key: msg.key ? msg.key : "0",
          },
        ],
        (err, data) => {
          if (err) {
            console.error("producer fail to write", err);
            reject(err);
            return;
          }
          resolve(data);
        }
      );
    });
  }
}

const sleep = (ttl) => new Promise((resolve) => setTimeout(resolve, ttl));

class QueueContainer {
  constructor(queue) {
    this.queue = queue;
    this.status = "not_started";
    this.messagesAcked = [];
  }

  async start() {
    if (this.status === "done" || this.status === "errored") return;
    this.status = "starting";
    try {
      const pub = new Publisher(this.queue.kafkaHost, this.queue.topic);
      await pub.init();
      this.status = "connected";
      for (let i = 0; i < this.queue.messages.length; i++) {
        const msg = this.queue.messages[i];
        if (!msg) {
          continue;
        }
        if (typeof msg === "number") {
          await sleep(msg);
        }
        if (typeof msg === "object" || typeof msg === "string") {
          await pub.send(msg);
          this.messagesAcked.push(i);
        }
      }
      this.status = "done";
    } catch (err) {
      console.error("queue halted", err);
      this.status = "errored";
      this.error = `internal error: ${err}, messages acked: ${this.messagesAcked}`;
    }
  }

  getState() {
    const state = {
      status: this.status,
      messagesAcked: this.messagesAcked,
    };
    if (this.error) {
      state.error = this.error;
    }
    return state;
  }
}

const store = {};

app.post("/api/produce", async (req, res) => {
  const queue = req.body;
  if (typeof queue !== "object") {
    await res.status(400).send("kafkaHost, messages and topic are required");
    return;
  }
  if (!queue.kafkaHost) {
    await res.status(400).send("kafkaHost is required");
    return;
  }
  if (!queue.messages || !queue.messages.length) {
    await res.status(400).send("at least one message is required");
    return;
  }
  if (!queue.topic) {
    await res.status(400).send("topic is required");
    return;
  }
  const id = uuid();
  store[id] = new QueueContainer(queue);
  setImmediate(() => store[id].start());
  res.send({
    id,
    state: store[id].getState(),
  });
});

app.get("/api/state/:id", (req, res) => {
  if (req.params.id in store) {
    res.send(store[req.params.id].getState());
  } else {
    res.status(404).send("not found");
  }
});

const port = 3000;

app.listen(port, function () {
  console.log(`Starting HTTP server on port: ${port}`);
});
