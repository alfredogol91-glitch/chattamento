# Chattamento

Una webapp per ritrovarsi con gli amici Erasmus: scegli una lingua, scegli un nickname e condividi l’invito alla tua stanza. Inglese, russo, spagnolo, ucraino e italiano sono disponibili sia per l’interfaccia sia per la traduzione dei messaggi di testo.

Questa versione funziona in diretta, senza un server applicativo da gestire, database o registrazione dei partecipanti. Messaggi e allegati non vengono conservati per chi è offline.

## Usarla con GitHub Pages: il metodo consigliato

Il sito usa GitHub Pages ed è compilato nella cartella `docs/` del repository. GitHub Pages è gratuito per questo repository pubblico. Puoi aprire [Chattamento](https://alfredogol91-glitch.github.io/chattamento/) senza scaricare file o creare un altro account. Per controllare o ripristinare la configurazione di pubblicazione:

1. Accedi a GitHub e apri [le impostazioni Pages del repository](https://github.com/alfredogol91-glitch/chattamento/settings/pages).
2. Nella sezione **Build and deployment**, imposta **Source** su **Deploy from a branch**.
3. Sotto **Branch**, scegli **main** e, nel menu della cartella, **/docs**.
4. Premi **Save** e aspetta che GitHub completi la pubblicazione; di solito servono alcuni minuti. Usa **Visit site** quando compare.
5. Apri il sito, scegli lingua e nickname, premi **Invita amici** e poi **Copia invito**. Manda l’invito completo alle persone che vuoi far entrare.

L’indirizzo è `https://alfredogol91-glitch.github.io/chattamento/`. Gli aggiornamenti diventano visibili quando GitHub completa la pubblicazione dei file caricati in `main/docs`. Il repository contiene anche lo ZIP pronto; non è necessario scaricarlo per usare questo metodo.

Dopo l’aggiornamento del collegamento della chat, chiudi le vecchie schede e apri [la versione aggiornata](https://alfredogol91-glitch.github.io/chattamento/?v=2), poi copia un nuovo invito dall’app. Il parametro `v=2`, presente anche nei nuovi inviti, evita di riutilizzare la pagina precedente dalla cache; stanza e chiave rimangono nella parte dopo `#`.

Per rigenerare la versione GitHub Pages dopo modifiche al codice, esegui `npm run build:github`, conserva il file `docs/.nojekyll` e carica i file aggiornati nel repository.

## Alternativa: pubblicare lo ZIP su Netlify Drop

L’archivio pronto da pubblicare si chiama **`chattamento-online.zip`**. Contiene già il sito completo: non devi scrivere codice né caricare il progetto su GitHub.

Il pacchetto è incluso anche direttamente in questo repository: apri [chattamento-online.zip](./chattamento-online.zip) e usa **Download raw file** (la freccia verso il basso) per salvarlo sul computer. Questo collegamento diventa disponibile su GitHub dopo il caricamento dei file nel repository.

1. Scarica `chattamento-online.zip` sul computer.
2. Estrai l’archivio: su Windows clic destro → **Estrai tutto**; su Mac fai doppio clic.
3. Apri la cartella estratta. Devi vedere il file **`index.html`** e la cartella **`assets`** al suo interno. Non aprire `index.html` con un doppio clic.
4. Apri [Netlify Drop](https://app.netlify.com/drop) con Chrome o un altro browser aggiornato.
5. Puoi iniziare il caricamento anche senza account; un account gratuito serve per gestire e aggiornare comodamente il sito. I tuoi amici non devono creare account. Questa app non richiede di configurare pagamenti.
6. Trascina sulla pagina di Netlify **la cartella che contiene `index.html` e `assets`**, poi aspetta la fine del caricamento.
7. Apri l’indirizzo **HTTPS** assegnato al sito. Scegli la lingua e il nickname, entra nella stanza e premi **Copia invito**.
8. Incolla quell’invito in WhatsApp, Telegram o dove preferisci. Chiedi a un amico di aprirlo, scegliere lingua e nickname, e lasciare la pagina aperta insieme a te.

Il link del sito e l’invito alla stanza hanno due funzioni diverse: visitando il sito senza invito si crea la propria stanza; l’invito completo permette ai tuoi amici di raggiungere **la tua stessa stanza**. Copia il link usando il pulsante dell’app, così la parte finale non viene persa.

Con Netlify Drop devi caricare nuovamente la cartella del sito per pubblicare un aggiornamento. Il piano gratuito di Netlify prevede una quota mensile: raggiunto il limite il sito può essere sospeso fino al rinnovo della quota. Non è stato attivato alcun servizio a pagamento.

## Come usarla

- **Per entrare:** scegli una delle cinque lingue, poi un nickname diverso da quelli già presenti nella stanza. Nessuna email o password.
- **Per invitare:** premi **Copia invito** e manda il link agli amici. Chiunque riceva o si faccia inoltrare quell’invito può entrare: il nickname non verifica l’identità.
- **Per scrivere:** usa la lingua che hai selezionato. Ogni destinatario vede la traduzione nella propria lingua e può leggere il testo originale.
- **Per mandare un file:** usa la graffetta, scegli il file e invialo mentre i destinatari sono connessi. Tieni la pagina aperta durante il trasferimento.
- **Per condividere una cartella:** apri **Cartelle condivise**, scegli una cartella, leggi il consenso e premi **Condividi questa cartella**. Gli amici nella stanza potranno sfogliarla e scegliere i file da scaricare. Premi **Interrompi condivisione** quando vuoi chiudere l’accesso.
- **Per il walkie-talkie:** entra nella chat vocale, consenti l’uso del microfono e tieni premuto il pulsante per parlare. Rilascia per tornare in silenzio. Da tastiera puoi tenere premuta la barra spaziatrice. È disponibile anche il microfono a mani libere.
- **Per vedervi:** avvia una videochiamata e consenti l’uso di microfono e videocamera. Gli amici nella stessa stanza possono partecipare.

Vengono tradotti **solo i messaggi scritti**. La voce e l’audio dei video restano nella lingua originale. Gli allegati non vengono tradotti.

## Condividere una cartella: come funziona il consenso

La condivisione è **in sola lettura e limitata alla cartella che scegli**, comprese le sue sottocartelle. L’app non dà accesso all’intero computer e non scansiona i tuoi file quando entri nel sito. Sei tu a premere **Scegli una cartella**, autorizzarne la lettura nel browser e confermare la condivisione. Scegliere la cartella da solo non la rende visibile agli amici.

Prima di premere **Condividi questa cartella**, devi accettare che **tutte le persone nella stanza, anche quelle che entreranno dopo**, possano vedere i nomi dei file, sfogliare le sottocartelle e scaricare i file che scelgono. Chi riceve un invito inoltrato può entrare nella stanza e ricevere lo stesso accesso. Non esiste una selezione dei singoli amici autorizzati all’interno della stanza.

Gli amici non possono modificare, rinominare o eliminare i file sul tuo computer. Quando sono disponibili, l’elenco mostra dimensione e data dell’ultima modifica. La navigazione gestisce fino a **5.000 elementi complessivi, contando sia file sia sottocartelle**, con un massimo di **1.000 elementi direttamente contenuti in ciascuna cartella**. Questi limiti valgono sia per la selezione diretta sia per quella compatibile basata sui file; se vengono superati, scegli una cartella più piccola. Ogni download richiede la scelta esplicita di un file da parte del destinatario; il limite per ciascun file scaricato è **25 MB**. Tieni la pagina aperta e la connessione attiva mentre qualcuno sfoglia o scarica.

Puoi condividere una cartella alla volta. Per sostituirla premi **Scegli un’altra cartella**, seleziona la nuova cartella, spunta la conferma di sostituzione e premi nuovamente **Condividi questa cartella**: la selezione non sostituisce da sola quella già condivisa.

Un indicatore mostra quando la condivisione è attiva e il comando **Interrompi condivisione** rimane disponibile. Fermarla, uscire dalla stanza o perdere la connessione blocca le nuove richieste e annulla quelle ancora in attesa, compresi i download in corso. I tuoi amici non potranno continuare a sfogliare la cartella o iniziare altri download. **Le copie già ricevute o salvate dai destinatari rimangono sui loro dispositivi e non possono essere richiamate.**

Per la selezione diretta di una cartella usa una versione recente di **Chrome o Edge su computer**, su un sito HTTPS. La disponibilità dipende dal browser e dal dispositivo: non tutti i telefoni o browser permettono di selezionare cartelle. Quando il browser offre invece una selezione dei file contenuti in una cartella, vengono condivisi solo i file selezionati in quel momento: le cartelle vuote e le modifiche successive non sono incluse. Per aggiornare quella selezione, scegli e condividi nuovamente la cartella.

L’app non mantiene un archivio online dei nomi, delle autorizzazioni o dei contenuti delle cartelle e non li ripristina nella sessione successiva. **Il consenso non viene ripristinato automaticamente:** dopo l’uscita o il ricaricamento devi scegliere la cartella e confermare di nuovo la condivisione, anche se il browser ricorda un permesso di lettura già concesso. Gli elenchi e i file richiesti passano attraverso servizi pubblici di inoltro dopo essere stati cifrati nel browser. Non vengono inviati al servizio di traduzione.

## Cosa resta quando chiudi la pagina

La conversazione vive nella memoria della scheda aperta. Quando esci o ricarichi, sul tuo dispositivo scompaiono i messaggi e gli allegati ricevuti in quella sessione. Le altre persone ancora connesse mantengono ciò che hanno già ricevuto nella propria scheda finché non la chiudono o ricaricano a loro volta. Un file scaricato volontariamente rimane nella cartella Download del dispositivo.

Non ci sono consegna a chi è offline, sincronizzazione della cronologia o archivi dei messaggi sul sito. Se una persona entra dopo l’invio, non riceve i messaggi precedenti. Conserva l’invito se vuoi riaprire la stessa stanza, ma la vecchia conversazione non verrà recuperata.

## Traduzioni e collegamenti gratuiti

Il testo viene tradotto dal servizio esterno **MyMemory**, senza una chiave API da inserire. Il browser invia a quel servizio il testo originale da tradurre: questo trattamento è distinto dalla cifratura della chat. MyMemory ha una quota gratuita limitata; disponibilità e qualità delle traduzioni non sono garantite. Se la traduzione non riesce, viene mostrato il testo originale con un avviso. Una traduzione può comparire qualche istante dopo il messaggio. Audio, video, allegati ed elenchi delle cartelle non vengono inviati al traduttore.

**Testo, allegati e cartelle condivise** usano due servizi pubblici gratuiti di inoltro MQTT su WebSocket sicuro: HiveMQ (`wss://broker.hivemq.com:8884/mqtt`) ed EMQX (`wss://broker.emqx.io:8084/mqtt`). Non servono account o pagamenti per collegarsi a questi servizi. Il browser prova entrambi: i dati della chat possono essere scambiati anche quando la rete non permette collegamenti WebRTC diretti. Se la rete blocca entrambi i servizi o le rispettive porte, occorre riprovare o cambiare rete.

I dati vengono cifrati nel browser con **AES-GCM a 256 bit** prima dell’inoltro. I broker non ricevono in chiaro messaggi, nomi di file o contenuti dei file. Possono osservare metadati quali indirizzo IP, canale opaco della stanza, chiavi pubbliche temporanee, dimensioni e tempi dei pacchetti. Il segreto della stanza è nella parte dell’invito dopo `#`: non viene inviato al sito di hosting o ai broker nelle richieste dell’app. Chi possiede l’invito completo può comunque entrare nella stanza e leggere i contenuti, anche se lo ha ricevuto da un altro partecipante.

L’app apre sessioni MQTT non persistenti (`cleanSession=true`), pubblica senza conservazione dei messaggi (`retain=false`) e ignora i messaggi conservati dai broker. La cronologia disponibile è solo nella memoria della scheda aperta. Questo comportamento non garantisce che i fornitori pubblici non conservino propri log o metadati: non sono servizi amministrati da Chattamento e non viene offerta una garanzia di disponibilità o velocità. I trasferimenti possono fallire o rallentare, soprattutto con file grandi.

**Audio e video** continuano a usare WebRTC e i servizi pubblici di segnalazione di Trystero. Il collegamento della chiamata viene associato all’identità temporanea del partecipante tramite una verifica crittografica; il nickname rimane comunque un nome scelto liberamente e non un’identità verificata. Non è configurato un server TURN: alcune reti mobili, universitarie o aziendali possono impedire le chiamate dirette anche quando testo e file funzionano. In quel caso l’app mostra l’errore e può essere necessario cambiare rete.

Il sito deve essere aperto tramite **HTTPS**; per lo sviluppo è consentito anche `localhost`. Aprire il file direttamente con `file://` non equivale a pubblicarlo e non è un metodo supportato. Questa architettura è pensata per piccoli gruppi di amici, senza un backend dell’app da gestire; dipende comunque dai servizi pubblici esterni descritti sopra.

## Sviluppo

Serve **Node.js 24** con npm. Nella cartella del progetto:

```sh
npm ci --cache /tmp/chattamento-npm-cache
npm run dev
```

Il server di sviluppo ascolta sulla porta 3000. Per preparare il sito statico:

```sh
npm run build
```

Il risultato è nella cartella `dist`: sono questi i file da pubblicare su un hosting statico HTTPS. Per controllare localmente la build:

```sh
npm start
```

Gli script di verifica disponibili si eseguono con:

```sh
npm test
npm run test:e2e
```

Il progetto attivo è un’app React/Vite che funziona nel browser. Non servono credenziali né variabili d’ambiente. `.env.example` lo ricorda: non inserire chiavi API o password nel codice del sito, perché i file pubblicati possono essere letti dai visitatori.

La suite automatica copre inviti, traduzioni, conversazioni e modello delle cartelle condivise; le prove browser verificano anche consenso, navigazione, download e revoca dell’accesso alle cartelle. I normali test di conversazione usano un trasporto locale deterministico al posto dei servizi pubblici esterni e risposte di traduzione simulate. Queste prove verificano l’applicazione ma non dimostrano da sole che due browser riescano a comunicare sulla rete reale. I controlli del walkie-talkie acquisiscono dispositivi simulati dal browser e verificano rilascio, tastiera, disconnessione e spegnimento dei dispositivi. I file delle prove non vengono inclusi nella build pubblicata.

È disponibile una verifica separata, facoltativa, che usa realmente i servizi esterni:

```sh
npm run test:network
```

Questa prova crea una stanza nuova, apre due sessioni browser separate e scambia messaggi in entrambe le direzioni. Ripete il controllo con WebRTC disabilitato, per verificare che il trasporto dei messaggi sia indipendente dalle chiamate. Non usa il trasporto simulato delle prove ordinarie e richiede accesso ai servizi pubblici; un loro blocco o disservizio può far fallire la verifica. Per controllare il sito pubblicato anziché il server locale:

```sh
CHATTAMENTO_URL=https://alfredogol91-glitch.github.io/chattamento/ npm run test:network
```

Usa l’indirizzo base del sito, senza un invito esistente. Questa verifica riguarda la chat: non certifica il funzionamento di audio e video attraverso ogni rete.

MyMemory è stato verificato con richieste HTTPS reali e supporta richieste dai browser (CORS); italiano, russo, spagnolo e ucraino hanno restituito traduzioni. È passata anche una traduzione reale nel browser attraverso `src/translate.js`, mantenendo la verifica TLS attiva. Nell’ambiente cloud Chromium richiede accesso autorizzato al proprio archivio NSS dei certificati, che nel sandbox ordinario è in sola lettura. Qualità e disponibilità delle traduzioni possono variare. La configurazione gestita del browser può bloccare UDP diretto: la verifica delle chiamate su dispositivi e reti reali rimane necessaria. Non sono stati disattivati i controlli TLS né le impostazioni gestite del browser.

Le prove automatiche non sostituiscono una prova su due dispositivi, usando l’indirizzo HTTPS pubblicato. Prima di invitare tutto il gruppo, verifica con un amico un messaggio tradotto, un file, la condivisione di una cartella, il walkie-talkie e una videochiamata. La build per GitHub Pages si trova in `docs/`; ogni aggiornamento diventa pubblico dopo il caricamento nel repository e la conclusione della pubblicazione di Pages.
