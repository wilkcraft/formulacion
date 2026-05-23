require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const nodemailer = require("nodemailer");

const admin = require("firebase-admin");
const path = require("path");
const serviceAccount = require(
  path.join(__dirname, process.env.FIREBASE_KEY_PATH),
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const dbAdmin = admin.firestore();
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const express = require("express");
const fs = require("fs");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { EmbedBuilder } = require("discord.js");

const app = express();
app.use(express.json());

const USERS_PATH = path.join(__dirname, "users.json");
const SECRET = process.env.JWT_SECRET;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.login(process.env.DISCORD_TOKEN);

client.once("clientReady", () => {
  console.log("Bot de Discord listo");
});

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("addnews")
    .setDescription("Añadir una novedad a la web")
    .addStringOption((option) =>
      option.setName("texto").setDescription("Texto").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("delnews")
    .setDescription("Eliminar una novedad")
    .addStringOption((option) =>
      option
        .setName("fecha")
        .setDescription("Selecciona la new")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName("news")
    .setDescription("Ver todas las novedades"),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID,
      ),
      { body: commands },
    );
    console.log("Comandos registrados");
  } catch (error) {
    console.error(error);
  }
})();

function getBasePath(type) {
  if (type === "inor") {
    return path.join(__dirname, "formulas/formInor");
  } else if (type === "or") {
    return path.join(__dirname, "formulas/formOr");
  } else if (type === "especial") {
    return path.join(__dirname, "formulas");
  } else {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).send("No autorizado");

  const token = authHeader.split(" ")[1];

  try {
    jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).send("Token inválido");
  }
}

// 🔹 LISTAR ARCHIVOS
app.get("/api/files", authMiddleware, (req, res) => {
  const type = req.query.type;
  const basePath = getBasePath(type);

  if (!basePath) return res.status(400).send("Tipo inválido");

  const files = fs
    .readdirSync(basePath)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(".js", ""));

  res.json(files);
});

// 🔹 OBTENER FORMULAS
app.get("/api/formulas/:type/:file", authMiddleware, (req, res) => {
  const { type, file } = req.params;
  const basePath = getBasePath(type);

  if (!basePath) return res.status(400).send("Tipo inválido");

  const filePath = path.join(basePath, `${file}.js`);

  if (!fs.existsSync(filePath)) return res.status(404).send("No existe");

  let content = fs.readFileSync(filePath, "utf-8");

  content = content.replace("export const formulas =", "").trim();

  try {
    const data = eval(content);
    res.json(data);
  } catch (err) {
    console.error("ERROR en:", filePath);
    console.error(err);
    res.status(500).send("Error evaluando archivo");
  }
});

// 🔹 GUARDAR
app.post("/api/formulas/:type/:file", authMiddleware, (req, res) => {
  const { type, file } = req.params;
  const basePath = getBasePath(type);

  if (!basePath) return res.status(400).send("Tipo inválido");

  const filePath = path.join(basePath, `${file}.js`);

  const newContent = `export const formulas = ${JSON.stringify(
    req.body,
    null,
    2,
  )};`;

  fs.writeFileSync(filePath, newContent);

  res.send("Guardado");
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  const users = JSON.parse(fs.readFileSync(USERS_PATH));

  const user = users.find((u) => u.username === username);
  if (!user) return res.status(401).send("Usuario incorrecto");

  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).send("Contraseña incorrecta");
  }

  const token = jwt.sign({ username }, SECRET, { expiresIn: "7d" });

  res.json({
    token,
    firstLogin: user.firstLogin || false,
  });
});

app.post("/api/change-password", authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const authHeader = req.headers.authorization;
  const token = authHeader.split(" ")[1];
  const decoded = jwt.verify(token, SECRET);

  const users = JSON.parse(fs.readFileSync(USERS_PATH));
  const user = users.find((u) => u.username === decoded.username);

  // ❌ contraseña actual incorrecta
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(400).send("Contraseña actual incorrecta");
  }

  // ❌ misma contraseña
  if (currentPassword === newPassword) {
    return res.status(400).send("No puedes usar la misma contraseña");
  }

  // ❌ mínimo 6 caracteres
  if (newPassword.length < 6) {
    return res.status(400).send("Mínimo 6 caracteres");
  }

  user.password = bcrypt.hashSync(newPassword, 10);
  user.firstLogin = false;

  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));

  res.send("Contraseña actualizada");
});

async function sendToDiscord({ title, color, fields, email }) {
  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(fields)
    .setTimestamp();

  // BOTONES (solo si hay email)
  const buttons = [];

  if (email) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`accept_${email}`)
        .setLabel("Aceptar")
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`reject_${email}`)
        .setLabel("Rechazar")
        .setStyle(ButtonStyle.Danger),
    );
  }

  // Botón terminado
  if (!email && fields) {
    const userField = fields.find((f) => f.name === "Usuario");
    const reportEmail = userField ? userField.value : "unknown";

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`done_${reportEmail}`)
        .setLabel("Terminado")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  const row = new ActionRowBuilder().addComponents(buttons);

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

client.on("interactionCreate", async (interaction) => {
  // =========================
  // 🔘 BOTONES
  // =========================
  if (interaction.isButton()) {
    const id = interaction.customId;

    // ✅ TERMINADO
    if (id.startsWith("done_")) {
      const email = id.replace("done_", "");

      try {
        // 📧 Enviar correo
        await transporter.sendMail({
          from: `"Reportes Formulación" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "Gracias por tu reporte",
          html: `
        <h2>✅ Error solucionado</h2>
        <p>Gracias por tu ayuda y aportación.</p>
        <p>El error que reportaste ya ha sido revisado y marcado como solucionado.</p>
        <br>
        <p>— Equipo de Wilkcraft</p>
      `,
        });

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle("✔️ Marcado como terminado")
              .setDescription(`📧 Correo enviado a ${email}`)
              .setColor(0x00ff00)
              .setTimestamp(),
          ],
          components: [],
        });
      } catch (err) {
        console.error(err);

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle("❌ Error enviando correo")
              .setDescription(`No se pudo enviar el correo a ${email}`)
              .setColor(0xff0000)
              .setTimestamp(),
          ],
          components: [],
        });
      }
    }

    // ✅ ACEPTAR
    if (id.startsWith("accept_")) {
      const email = id.replace("accept_", "");

      try {
        // Añadir a whitelist
        await dbAdmin.collection("whitelist").doc(email.toLowerCase()).set({
          createdAt: new Date(),
        });

        // 📧 Enviar correo de aceptación
        await transporter.sendMail({
          from: `"Formulación Química" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "Solicitud aceptada",
          html: `
        <h2>✅ Acceso aprobado</h2>

        <p>Tu solicitud ha sido aceptada correctamente.</p>

        <p>
          Ya puedes utilizar las funciones autorizadas de la web de
          formulación química.
        </p>

        <br>

        <p>Gracias por colaborar.</p>

        <p>— Equipo de Wilkcraft</p>
      `,
        });

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle("✅ Solicitud aceptada")
              .setDescription(
                `El usuario **${email}** ha sido añadido a la whitelist y se le ha enviado un correo.`,
              )
              .setColor(0x00ff00)
              .setTimestamp(),
          ],
          components: [],
        });
      } catch (err) {
        console.error(err);

        return interaction.update({
          embeds: [
            new EmbedBuilder()
              .setTitle("❌ Error al aceptar")
              .setDescription(`No se pudo procesar **${email}**`)
              .setColor(0xff0000)
              .setTimestamp(),
          ],
          components: [],
        });
      }
    }

    // ❌ RECHAZAR
    if (id.startsWith("reject_")) {
      const email = id.replace("reject_", "");

      return interaction.update({
        content: `❌ ${email} rechazado`,
        embeds: [],
        components: [],
      });
    }
  }

  // =========================
  // 🔎 AUTOCOMPLETE
  // =========================
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "delnews") {
      const focused = interaction.options.getFocused();

      try {
        const snapshot = await dbAdmin.collection("novedades").get();

        let opciones = [];

        snapshot.forEach((doc) => {
          const fechaID = doc.id;

          // convertir dd_mm_aaaa → Date
          const [d, m, a] = fechaID.split("_");
          const fecha = new Date(a, m - 1, d);

          opciones.push({
            name: fechaID.replace(/_/g, "/"),
            value: fechaID,
            fecha,
          });
        });

        // ordenar por fecha descendente (más nueva primero)
        opciones.sort((a, b) => b.fecha - a.fecha);

        // filtrar según lo escrito
        const filtradas = opciones
          .filter((opt) =>
            opt.name.toLowerCase().includes(focused.toLowerCase()),
          )
          .slice(0, 25)
          .map((opt) => ({
            name: opt.name,
            value: opt.value,
          }));

        await interaction.respond(filtradas);
      } catch (err) {
        console.error(err);
        await interaction.respond([]);
      }
    }
  }

  // =========================
  // ⚡ COMANDOS SLASH
  // =========================
  if (interaction.isChatInputCommand()) {
    // 📰 ADD NEWS
    if (interaction.commandName === "addnews") {
      // 🔒 (Opcional pero recomendado)
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({
          content: "❌ No tienes permisos",
          ephemeral: true,
        });
      }

      const texto = interaction.options.getString("texto");

      // 📅 Fecha automática
      const now = new Date();
      const dia = String(now.getDate()).padStart(2, "0");
      const mes = String(now.getMonth() + 1).padStart(2, "0");
      const año = now.getFullYear();

      const fechaID = `${dia}_${mes}_${año}`;

      try {
        await dbAdmin.collection("novedades").doc(fechaID).set({
          text: texto,
        });

        return interaction.reply({
          content: `✅ Novedad guardada para ${fechaID}`,
          ephemeral: true,
        });
      } catch (err) {
        console.error(err);

        return interaction.reply({
          content: "❌ Error guardando la novedad",
          ephemeral: true,
        });
      }
    }

    // 🗑 DELETE NEWS
    if (interaction.commandName === "delnews") {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({
          content: "❌ No tienes permisos",
          ephemeral: true,
        });
      }

      const fechaID = interaction.options.getString("fecha");

      try {
        await dbAdmin.collection("novedades").doc(fechaID).delete();

        return interaction.reply({
          content: `🗑️ Novedad ${fechaID} eliminada`,
          ephemeral: true,
        });
      } catch (err) {
        console.error(err);
        return interaction.reply({
          content: "❌ Error eliminando",
          ephemeral: true,
        });
      }
    }

    // 📜 VER NEWS
    if (interaction.commandName === "news") {
      try {
        const snapshot = await dbAdmin.collection("novedades").get();

        let novedades = [];

        snapshot.forEach((doc) => {
          const fechaID = doc.id;
          const texto = doc.data().text;

          const [d, m, a] = fechaID.split("_");
          const fecha = new Date(a, m - 1, d);

          novedades.push({ fechaID, texto, fecha });
        });

        // ordenar por fecha descendente
        novedades.sort((a, b) => b.fecha - a.fecha);

        if (novedades.length === 0) {
          return interaction.reply("No hay novedades.");
        }

        const embed = new EmbedBuilder()
          .setTitle("📰 Novedades")
          .setColor(0x3498db)
          .setTimestamp();

        novedades.slice(0, 10).forEach((n) => {
          embed.addFields({
            name: `📅 ${n.fechaID.replace(/_/g, "/")}`,
            value: n.texto,
          });
        });

        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        return interaction.reply("❌ Error cargando novedades");
      }
    }
  }
});

// 🚨 ERROR
app.post("/api/report-error", async (req, res) => {
  const { email, error, fecha, hora } = req.body;

  const message =
    `🚨 Nuevo reporte de error\n\n` +
    `👤 Usuario: ${email}\n` +
    `📅⏰ Día: ${fecha}  |  Hora: ${hora}\n\n` +
    `⚠️ Error: ${error}\n`;

  try {
    await sendToDiscord({
      title: "🚨 Nuevo reporte de error",
      color: 0xff0000,
      fields: [
        { name: "Usuario", value: email },
        { name: "Fecha", value: `${fecha} ${hora}` },
        { name: "Error", value: error },
      ],
    });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// 📩 ACCESO
app.post("/api/request-access", async (req, res) => {
  const { email, tipo, fecha, hora } = req.body;

  const message =
    `📩 Solicitud de acceso\n\n` +
    `👤 Usuario: ${email}\n` +
    `📅⏰ Día: ${fecha}  |  Hora: ${hora}\n\n`;

  try {
    await sendToDiscord({
      title: "📩 Solicitud de acceso",
      color: 0x3498db,
      email,
      fields: [
        { name: "Usuario", value: email },
        { name: "Tipo solicitado", value: tipo },
        { name: "Fecha", value: `${fecha} ${hora}` },
      ],
    });
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3127;
app.listen(PORT, () => console.log("Backend en puerto " + PORT));
