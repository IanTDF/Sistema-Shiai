const firebaseConfig = {
  apiKey: "AIzaSyBxr7iM-zVCG8bcHLPRZDfzJbbrx51hMks",
  authDomain: "sistema-sensei-ian.firebaseapp.com",
  projectId: "sistema-sensei-ian",
  storageBucket: "sistema-sensei-ian.firebasestorage.app",
  messagingSenderId: "803865605233",
  appId: "1:803865605233:web:e344d137057dfcf44d17d0"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Opcional: o celular continua funcionando se o wi-fi do ginásio cair
// e sincroniza quando a conexão voltar.
db.enablePersistence({ synchronizeTabs: true }).catch(() => {});