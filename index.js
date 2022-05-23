const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 5000;
const jwt = require("jsonwebtoken");

app.use(cors());
app.use(express.json());

var uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0-shard-00-00.k7r9t.mongodb.net:27017,cluster0-shard-00-01.k7r9t.mongodb.net:27017,cluster0-shard-00-02.k7r9t.mongodb.net:27017/?ssl=true&replicaSet=atlas-y169eq-shard-0&authSource=admin&retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({
      message: "UnAuthorized Access",
    });
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
    if (err) {
      return res.status(403).send({
        message: "Forbidden Access",
      });
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    await client.connect();
    const serviceCollection = client
      .db("doctors_portal")
      .collection("services");
    const bookingCollection = client
      .db("doctors_portal")
      .collection("bookings");
    const userCollection = client.db("doctors_portal").collection("users");
    const doctorCollection = client.db("doctors_portal").collection("doctors");
    const paymentCollection = client.db("doctors_portal").collection("payments");

    //verify Admin
    const verifyAdmin = async (req, res, next) => {
      const requester = req.decoded.email;
      const requesterAccount = await userCollection.findOne({
        email: requester,
      });
      if (requesterAccount.role === "admin") {
        next();
      } else {
        res.status(403).send({
          message: "Forbidden",
        });
      }
    };

    app.get("/services", async (req, res) => {
      const query = {};
      const cursor = serviceCollection.find(query).project({
        name: 1,
      });
      const services = await cursor.toArray();
      res.send(services);
    });

    //  Get All Users
    app.get("/users", verifyJWT, async (req, res) => {
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    //Add Admin User
    app.put("/user/admin/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;

      const filter = {
        email: email,
      };
      const updateDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await userCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    ///Check Admin User
    app.get("/admin/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({
        email: email,
      });
      const isAdmin = user.role === "admin";
      res.send({
        admin: isAdmin,
      });
    });

    ////////////////////////////////////////
    app.put("/user/:email", async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const filter = {
        email: email,
      };
      const options = {
        upsert: true,
      };
      const updateDoc = {
        $set: user,
      };

      const result = await userCollection.updateOne(filter, updateDoc, options);
      const token = jwt.sign(
        {
          email: email,
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
          expiresIn: "12h",
        }
      );
      res.send({
        result,
        token,
      });
    });

    app.get("/available", async (req, res) => {
      const date = req.query.date;
      // get All Services
      const services = await serviceCollection.find().toArray();
      //get booking of that day
      const query = {
        date: date,
      };
      const bookings = await bookingCollection.find(query).toArray();
      //find bookings for that service
      services.forEach((service) => {
        const serviceBooking = bookings.filter(
          (b) => b.treatment === service.name
        );
        const bookedSlots = serviceBooking.map((s) => s.slot);

        const available = service.slots.filter((s) => !bookedSlots.includes(s));

        service.slots = available;
        // service.booked = booked;
        // console.log(service.booked);
        // service.booked = serviceBooking.map(s=>s.slot);
      });

      res.send(services);
    });

    //Get Booking For Payment
    app.get('/booking/:id',verifyJWT,async(req,res)=>{
      const id = req.params.id;
      const query = {_id:ObjectId(id)}
      const booking = await bookingCollection.findOne(query);
      res.send(booking);
    })

    //Get Booking
    app.get("/booking", verifyJWT, async (req, res) => {
      const patient = req.query.patient;
      const decodedEmail = req.decoded.email;
      if (patient === decodedEmail) {
        const query = {
          patient: patient,
        };
        const bookings = await bookingCollection.find(query).toArray();
        return res.send(bookings.reverse());
      } else {
        return res.status(403).send({
          message: "Forbidden Access",
        });
      }
    });

    // Add booking
    app.post("/booking", async (req, res) => {
      const booking = req.body;
      const query = {
        treatment: booking.treatment,
        date: booking.date,
        patient: booking.patient,
      };
      const exists = await bookingCollection.findOne(query);
      console.log(query);
      if (exists) {
        return res.send({
          success: false,
          booking: exists,
        });
      }
      const result = await bookingCollection.insertOne(booking);
      return res.send({
        success: true,
        result,
      });
    });

    //Get All Doctor
    app.get("/doctors", verifyJWT, verifyAdmin, async(req, res) => {
      const doctors = await doctorCollection.find().toArray();
      console.log(doctors);
      res.send(doctors);
    });

    // Add Doctor With Image
    app.post("/doctor", verifyJWT, verifyAdmin, async(req, res) => {
      const doctor = req.body;
      const result = await doctorCollection.insertOne(doctor);
      res.send(result);
    });

    app.delete("/doctor/:email", verifyJWT, verifyAdmin, async(req, res) => {
      const email = req.params.email;
      const filter ={email:email}
      const result = await doctorCollection.deleteOne(filter);
      res.send(result);
    });

  //  stripe Api
  app.post('/create-payment-intent',verifyJWT, async(req,res)=>{
      const service = req.body;
      const price = service.price;
      const amount = price * 100;
      const paymentIntent = await stripe.paymentIntents.create({
        amount:amount,
        currency:'usd',
        payment_method_types: ['card'],
      })

      res.send({clientSecret: paymentIntent.client_secret,
      });

  })

  //Payment With stripe and Update
  app.patch('/booking/:id',verifyJWT,async(req,res)=>{
    const id = req.params.id;
    const payment= req.body;
    const filter = {_id:ObjectId(id)};
    const updatedDoc = {
      $set:{
        paid:true,
        transactionId : payment.transactionId
      }
    }
    const result = await paymentCollection.insertOne(payment);
    const updatedBooking = await bookingCollection.updateOne(filter,updatedDoc);
    res.send(updatedDoc);
  })


  } 
  finally {
  }
}

run().catch(console.dir);



app.get("/", (req, res) => {
  res.send("Hello Doctor Uncle!");
});

app.listen(port, () => {
  console.log(`Doctors app listening on port ${port}`);
});
