# Infolab Offline CBT – restored project
Folders: offline-cbt (Admin + server), student-client, teacher-client.
Each: `npm install` then `npm start` (test) or `npm run build:win` (installer -> dist-exe).
Admin server test without Electron: `cd offline-cbt && npm install && node server/index.js` -> http://localhost:4000
Admin URLs: / (admin), /student, /teacher. Clients ask for the Admin PC's IP.
Reconstructed files (rewritten, not original): offline-cbt/electron-main.js, client/student.html,
teacher-client/client/index.html, .env.example. Verify against your installed app (resources/app.asar) if possible.
