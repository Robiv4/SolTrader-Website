# Autonomous ML tanítás – memóriajavítás: telepítés és visszaállítás (meglévő VPS)

Csak PAPER. A javítás a kereskedést nem érinti: a trading workert és az Exit Engine-t **nem kell** újraépíteni vagy
újraindítani. Adatbázis-migráció **nincs**. Semmit nem pusholtunk és nem telepítettünk automatikusan.

Érintett szolgáltatások: `ml-trainer` (dataset-előkészítés + Python tanító) és `web` (valós dataset-progress kijelzés).

- VPS könyvtár: `/home/soltrader/apps/soltrader`
- `dc` = `docker compose -f docker-compose.yml -f docker-compose.vps.yml`

**Tilos:** `prisma migrate reset`, `docker compose down -v`, `git reset --hard`, `git clean -fd`, kötetek / modellek /
datasetek törlése, LIVE bekapcsolása, DEFAULT stratégia visszakapcsolása.

```bash
cd /home/soltrader/apps/soltrader
alias dc='docker compose -f docker-compose.yml -f docker-compose.vps.yml'
```

## 1. Előzetes ellenőrzés

```bash
git status --short
git log -1 --oneline
git rev-parse HEAD > ~/soltrader-pre-memfix-commit.txt
grep -E "^(TRADING_MODE|LIVE_TRADING_ENABLED|ML_ONLY_ARCHITECTURE_ENABLED|AUTONOMOUS_ML_ENABLED|ML_TRAINER_MEMORY|ML_TRAINER_NODE_OPTIONS)=" .env
df -h .                      # szabad hely: lásd 4. pont
```

Elvárt: `TRADING_MODE=PAPER`, `LIVE_TRADING_ENABLED=false`, `ML_ONLY_ARCHITECTURE_ENABLED=true`, `AUTONOMOUS_ML_ENABLED=true`.

Fut-e tanítás? (Ha igen: várd meg, vagy szakítsd meg a weben. A korábbi `FAILED / INTERRUPTED` sorok megmaradnak.)

```bash
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select id, status, stage, error, \"requestedAt\" from \"MlTrainingJob\" order by \"requestedAt\" desc limit 5;"'
```

## 2. Mentés

Nincs sémaváltozás és nincs adatmódosítás; a teljes 35 GB-os dump ezért nem feltétele a telepítésnek. Az ML-registry
táblái és fájljai kicsik, ezeket mentjük:

```bash
B=~/soltrader-backups/pre-memfix-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -t "\"MlTrainingJob\"" -t "\"MlDatasetVersion\"" -t "\"MlAutonomousModelBundle\"" "$POSTGRES_DB"' > "$B/ml-registry.dump"
ls -lh "$B/ml-registry.dump"
cp -a .env "$B/.env" && chmod 600 "$B/.env"
cp -a docker-compose.vps.yml "$B/"
git diff > "$B/vps-local.patch"
tar czf "$B/ml-autonomous-models.tgz" ml/autonomous-models
tar czf "$B/ml-models.tgz" ml/models
# A meglévő autonóm datasetek fájljai (nagyok lehetnek): csak ha van hely
du -sh ml/autonomous-datasets
```

## 3. Kód frissítése

```bash
git stash push -m "vps-local-pre-memfix"
git fetch origin
git checkout feature/community-ml
git pull --ff-only origin feature/community-ml
git stash pop
git status --short
git log -1 --oneline
```

## 4. Konfiguráció (`.env`, kézzel)

- `ML_TRAINER_MEMORY=3g` maradhat (ajánlott). A Node heap alapértéke a compose-ban 1024 MB; a javított dataset-előkészítés
  mért csúcsa 600 000 sornál ~150 MB, 1 000 000 sornál ~175 MB. Ha korábban `ML_TRAINER_NODE_OPTIONS=--max-old-space-size=2048`
  került be, az maradhat, de **nem szükséges**; a 3 GB-ból így több marad a Python tanítónak.
  A Python tanító mért csúcsa (600 000 sor, streaming): ~724 MB privát memória (+ visszanyerhető fájl-cache a
  lemezre leképezett mátrixokból); a régi betöltéssel ugyanez 3,4 GB volt.
- Opcionális finomhangolás (alapértékek biztonságosak): `ML_DATASET_REPLAY_PAGE_SIZE=200`, `ML_DATASET_LIVE_PAGE_SIZE=500`,
  `ML_DATASET_SORT_CHUNK_ROWS=25000`.
- **Szabad lemezhely:** tanítás közben ideiglenes fájlok keletkeznek (rendezett darabok a dataset mellett, a Python
  tanító lemezre leképezett mátrixai a modellek mellett); a végén törlődnek. Igény: kb. a végső `dataset.csv` 4-szerese
  + maga a CSV (mért: 347 MB CSV mellett 575 MB nyers tömb + a legnagyobb tanítómátrix). ~1,2 millió sornál (~0,7 GB CSV) legalább **5 GB** szabad hely legyen a projekt lemezén.
- A `docker-compose.vps.yml`-ben az `ml-trainer` ugyanúgy kapja a `.env`-et és a `./ml/autonomous-datasets`,
  `./ml/autonomous-models` köteteket, mint eddig (változás nem kell).

```bash
dc config | grep -nE "ML_DATASET_|NODE_OPTIONS|mem_limit|autonomous-(datasets|models)"
```

## 5. Build és frissítés (csak `ml-trainer` és `web`)

```bash
dc build ml-trainer web
dc up -d --no-deps ml-trainer
dc up -d --no-deps web
dc ps
```

A worker, az API, a Postgres és a Redis nem indul újra. Az `ml-trainer` indulásakor a futás közben megszakadt korábbi
feladatok `FAILED / INTERRUPTED` állapotba kerülnek (történet megmarad), és törlődnek a már befejezett feladatokhoz
tartozó ideiglenes `.build-*` / `.work-*` könyvtárak (csak azok, amelyekben a feladat saját jelölőfájlja van).

## 6. Ellenőrzés

```bash
dc logs --since 5m ml-trainer | tail -20     # "ml-trainer started (no trading in this process)"
dc exec -T ml-trainer printenv ML_PYTHON TRADING_MODE LIVE_TRADING_ENABLED NODE_OPTIONS
dc exec -T ml-trainer /opt/ml-venv/bin/python -c "import lightgbm, numpy, pandas; print('ml ok', lightgbm.__version__)"
dc exec -T ml-trainer pnpm ml:autonomous:status | head -20     # CLI a konténerből (ugyanaz a pipeline)
```

Az `ml:trainer:health` Redis-életjel a weben: Machine Learning → Speciális diagnosztika → Tanítási naplók
(„ml-trainer szolgáltatás fut (jelentés: …)”); 10 mp-enként frissül, tanítás közben is.

**Tanítás a weben:** Machine Learning → Modellek → „+ Új ML modell tanítása”. A feladat nézetében a „Dataset-előkészítés
(mért értékek)” blokk mutatja: fázis, feldolgozott REPLAY / LIVE snapshotok, ENTRY / POSITION sorok, kizárt minták,
CSV-be írt sorok és MB, Node heap.

Párhuzamosan figyelve:

```bash
docker stats --no-stream soltrader-ml-trainer
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select status, stage, \"heartbeatAt\", result->'"'"'progress'"'"' from \"MlTrainingJob\" order by \"requestedAt\" desc limit 1;"'
dc logs -f ml-trainer
```

Elvárt: a fázisok haladnak (COUNTING → REPLAY → LIVE → WRITING_CSV → MANIFEST → REGISTERING), a `heartbeatAt` 15 mp-enként
frissül, nincs `heap out of memory`; utána LOADING_DATASET → ENTRY_MODELS → EXIT_MODELS → VALIDATION → SAVING →
COMPLETED. Az elkészült modell **nem aktív** (TRAINED); aktiválni csak az eddigi kézi ellenőrzés + jóváhagyás után lehet.

**CLI alternatíva a konténerből** (webes tanítás közben megtagadja, `--force` nélkül):

```bash
dc exec ml-trainer pnpm ml:autonomous:dataset
dc exec ml-trainer pnpm ml:autonomous:train --dataset AUTO-DATASET-vN --seed 42
dc exec ml-trainer pnpm ml:autonomous:status
```

**PAPER biztonság:**

```bash
dc exec -T worker printenv TRADING_MODE LIVE_TRADING_ENABLED ML_ONLY_ARCHITECTURE_ENABLED AUTONOMOUS_ML_ENABLED
```

## 7. Visszaállítás (rollback)

Nincs DB-változás, nincs visszaállítandó séma. Az új kóddal készült datasetek formátuma azonos a régivel (bájtra
azonos CSV ugyanarra a bemenetre), a régi kód is olvassa őket.

```bash
PREV=$(cat ~/soltrader-pre-memfix-commit.txt)
dc stop ml-trainer                  # csak leállítás; adat / kötet nem törlődik
git stash push -m "vps-local-memfix"
git checkout "$PREV"
git stash pop                       # ütközésnél: "$B/vps-local.patch"
dc build ml-trainer web
dc up -d --no-deps ml-trainer web
dc ps
```

Ha egy félbeszakadt build ideiglenes könyvtára maradt (`ml/autonomous-datasets/.build-*`, `ml/autonomous-models/.work-*`)
és **nem fut tanítás**, kézzel törölhető — csak a ponttal kezdődő ideiglenes könyvtárak, soha egy verziókönyvtár:

```bash
ls -d ml/autonomous-datasets/.build-* ml/autonomous-models/.work-* 2>/dev/null
```

## 8. Ami nincs production-ellenőrizve

A javítás a fejlesztői gépen szintetikus, valós méretű (600 000 – 1 000 000 soros) adatokon és a helyi
adatbázison tesztelt; a valódi 35 GB-os VPS-adatbázison még nem futott. A Docker image buildje helyben nem volt
ellenőrizhető. Az első VPS-tanítás a valódi ellenőrzés: figyeld a `docker stats` memóriát és a heartbeatet.
