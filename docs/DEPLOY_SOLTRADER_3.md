# SolTrader 3.0 – telepítési és visszaállítási terv (VPS)

Csak PAPER. A telepítés LIVE kereskedést nem kapcsol be, kereskedési paramétert nem módosít. Minden lépést kézzel,
sorban kell futtatni; a terv semmit nem pusholt és semmit nem telepített automatikusan.

- VPS könyvtár: `/home/soltrader/apps/soltrader`
- Compose: `docker compose -f docker-compose.yml -f docker-compose.vps.yml …` (az alábbiakban `dc`)
- Új a 3.0-ban: 3 additív migráció, `ml-trainer` szolgáltatás (külön konténer, CPU/memória korláttal),
  `ml/autonomous-datasets` és `ml/autonomous-models` kötetek, új ML felület (Áttekintés / Modellek / Eredmények).

**Tilos:** `prisma migrate reset`, `git reset --hard`, `git clean -fd`, `docker compose down -v`, kötetek törlése,
`ml/models` / `ml/datasets` felülírása.

```bash
cd /home/soltrader/apps/soltrader
alias dc='docker compose -f docker-compose.yml -f docker-compose.vps.yml'
```

## 0. Előfeltételek

- A `feature/community-ml` ág a fejlesztői gépről fel van pusholva (ezt a felhasználó végzi el kézzel).
- Elég szabad lemezhely a mentésekhez és az új image-hez: `df -h .` (legalább ~5 GB ajánlott).
- Nincs futó betanítás (a 3.0 előtt ilyen még nem létezik).

## 1. Git állapot ellenőrzése (semmit nem dob el)

```bash
git status --short
git branch --show-current
git log -1 --oneline
git diff --stat            # helyi VPS módosítások (pl. az OpenSSL Dockerfile javítás)
git ls-files docker-compose.vps.yml   # üres kimenet = nincs gitben (helyi fájl, a pull nem érinti)
```

Jegyezd fel a jelenlegi commitot (rollbackhez):

```bash
git rev-parse HEAD > ~/soltrader-pre-3.0-commit.txt
```

## 2. Mentés

```bash
B=~/soltrader-backups/pre-3.0-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"
# Adatbázis (a konténer saját környezeti változóival, jelszó nem kerül a parancssorba)
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$B/soltrader.dump"
ls -lh "$B/soltrader.dump"     # nem lehet 0 bájt
dc exec -T postgres sh -c 'pg_restore -l /dev/stdin' < "$B/soltrader.dump" | head -5   # olvasható-e a dump
# Helyi konfiguráció és a helyi VPS módosítások
cp -a .env "$B/.env"
cp -a docker-compose.vps.yml "$B/"
git diff > "$B/vps-local.patch"          # pl. OpenSSL Dockerfile javítás
# ML modellek és datasetek (a v3 modell is)
tar czf "$B/ml-models.tgz" ml/models
tar czf "$B/ml-datasets.tgz" ml/datasets
sha256sum ml/models/*/*.json > "$B/ml-models.sha256" 2>/dev/null || true
chmod 600 "$B/.env"
```

Opcionálisan Redis: `dc exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning BGSAVE` (a Redis cache /
állapot, nem elsődleges adat).

## 3. Kód frissítése (a helyi módosítások megőrzésével)

```bash
git stash push -m "vps-local-pre-3.0"          # a helyi Dockerfile javítás biztonságban
git fetch origin
git checkout feature/community-ml
git pull --ff-only origin feature/community-ml
git stash pop                                   # a helyi javítás visszakerül (3-utas merge)
git status --short
git diff Dockerfile                             # a helyi OpenSSL javítás + az új ml-trainer stage együtt
```

Ha a `stash pop` ütközést jelez a `Dockerfile`-ban: oldd fel kézzel úgy, hogy a helyi OpenSSL javítás és az új
`ml-trainer` stage is megmaradjon; a mentés `"$B/vps-local.patch"`. A stash csak sikeres pop után törlődik.

## 4. A VPS override kiegészítése (`docker-compose.vps.yml`)

A `docker-compose.vps.yml` nincs gitben, ezért a pull nem frissíti. Ellenőrizd és kézzel egészítsd ki:

1. **Környezet:** az alap compose nem olvassa be a `.env`-et a konténerekbe (nincs `env_file`), és a `.dockerignore`
   kizárja az image-ből. Ahogyan az override a `worker`-nek/`api`-nak adja (`env_file: .env` vagy `.env` mount),
   ugyanúgy add meg az `ml-trainer`-nek is.
2. **Kötetek:** ha az override felülírja a `volumes` listát a `worker` / `api` szolgáltatásnál, vedd fel mindkettőt:
   `./ml/autonomous-datasets:/app/ml/autonomous-datasets` és `./ml/autonomous-models:/app/ml/autonomous-models`.
   Ugyanez kell az `ml-trainer`-nek (az alap compose már tartalmazza; csak felülírt lista esetén kell).
3. **Adatbázis elérése:** az `ml-trainer` a `DATABASE_URL_DOCKER`-t használja (mint a worker).
4. **Erőforrások** (opcionális): `ML_TRAINER_CPUS` (alap 1.0), `ML_TRAINER_MEMORY` (alap 2g),
   `ML_TRAINER_NODE_OPTIONS` (alap `--max-old-space-size=1024`). Kis VPS-en maradjon 1 CPU.

Ellenőrzés (szolgáltatások, kötetek, PAPER beállítás):

```bash
dc config --services                  # api, ml-trainer, postgres, redis, web, worker
dc config | grep -nE "autonomous-(datasets|models)|TRADING_MODE|LIVE_TRADING_ENABLED|mem_limit|cpus"
mkdir -p ml/autonomous-datasets ml/autonomous-models
```

## 5. ML-only döntés (`.env`)

- `ML_ONLY_ARCHITECTURE_ENABLED=false` (alapértelmezés): a régi DEFAULT stratégia azoknál a felhasználóknál kereskedhet,
  akik azt választották; a felület ezt jelzi. **Ajánlott a 3.0 céljához:** `true` – ekkor a DEFAULT soha nem nyit,
  modell nélkül csak adatgyűjtés fut. Ez döntés: a `.env`-ben kézzel kell beállítani (mentés után).
- `AUTONOMOUS_ML_ENABLED=true` (alap): adatgyűjtés minden launch-ra; kereskedés csak jóváhagyott + kiválasztott modellel.
- Ellenőrizd: `grep -E "^(TRADING_MODE|LIVE_TRADING_ENABLED)=" .env` → `PAPER` és `false`.

## 6. Migráció (additív)

Új migrációk: `20261022141535_ml_only_trading_pause`, `20261022144637_autonomous_ml`,
`20261022152307_ml_training_jobs` – csak új táblák / új, nullázható vagy alapértékes oszlopok; meglévő adatot
nem törölnek, nem írnak át.

```bash
dc build api                      # az új séma + prisma CLI az image-ben
dc run --rm --no-deps api npx prisma migrate status --schema prisma/schema.prisma
dc run --rm --no-deps api npx prisma migrate deploy --schema prisma/schema.prisma
dc run --rm --no-deps api npx prisma migrate status --schema prisma/schema.prisma   # "Database schema is up to date"
```

Ha a `migrate status` nem csak a fenti 3 migrációt jelzi függőként: **állj meg**, ne futtasd a deployt.

## 7. Build és szolgáltatások frissítése

```bash
dc build worker web ml-trainer
dc up -d --no-deps api
dc up -d --no-deps worker         # nyitott PAPER pozíciók: az Exit Engine a DB-ből folytatja
dc up -d --no-deps web
dc up -d --no-deps ml-trainer
dc ps
```

Nincs `down`, nincs `-v`: a Postgres / Redis konténer és adatai nem érintettek.

## 8. Ellenőrzések

**Szolgáltatások / naplók**

```bash
dc logs --since 5m worker | grep -iE "error|autonomous|exit" | tail -30
dc logs --since 5m ml-trainer | tail -20       # "ml-trainer started (no trading in this process)", hibák nélkül
dc logs --since 5m api | grep -iE "error" | tail -20
dc exec -T ml-trainer /opt/ml-venv/bin/python -c "import lightgbm, sklearn, pandas; print('ml ok', lightgbm.__version__)"
```

**API / UI** (böngészőben, bejelentkezve)

- `/machine-learning`: Áttekintés / Modellek / Eredmények fülek; Speciális diagnosztika link.
- Beállítások: „Aktív kereskedési ML modell”, alapból „Nincs modell – csak adatgyűjtés” (vagy a régi DEFAULT
  jelzése, ha ML-only ki van kapcsolva). Nincs DEFAULT választó.
- A v3 modell (`ML-LGBM-NL-DATASET-v3-s42`) és a korábbi eredmények változatlanul láthatók.

**Adatgyűjtés** (pár perc után)

```bash
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*), max(\"snapshotAt\") from \"MlAutonomousDecisionSnapshot\";"'
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*), max(\"snapshotAt\") from \"MlFeatureSnapshot\";"'
```

Mindkettő nő; a Community / Telegram gyűjtés a korábbiak szerint fut (a Telegram kiesése csak null jellemzőket ad).

**PAPER biztonság**

```bash
dc exec -T worker printenv TRADING_MODE LIVE_TRADING_ENABLED ML_ONLY_ARCHITECTURE_ENABLED
dc exec -T ml-trainer printenv TRADING_MODE LIVE_TRADING_ENABLED
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from \"MlAutonomousPosition\";"'   # 0, amíg nincs jóváhagyott + kiválasztott modell
```

**Betanítás** (opcionális, ha van elég adat): a Modellek fülön „Új modell tanítása” → a feladat a `ml-trainer`
konténerben fut; az elkészült modell **nem aktiválódik** automatikusan. Kevés adatnál a tanítás érthető hibával
(minimum sorszám) áll le – ez várt működés.

## 9. Visszaállítás (rollback)

A migrációk additívak, a régi kód figyelmen kívül hagyja az új táblákat: adatbázis-visszaállítás **nem** kell.

```bash
PREV=$(cat ~/soltrader-pre-3.0-commit.txt)
dc stop ml-trainer                         # nem törli a konténer köteteit / adatait
git stash push -m "vps-local-3.0"          # helyi javítás megőrzése
git checkout "$PREV"
git stash pop                              # ütközésnél: "$B/vps-local.patch"
dc build api worker web
dc up -d --no-deps api worker web
dc ps
```

- A régi kód nem ismeri az `ML_AUTONOMOUS` stratégiát: aki 3.0 alatt Autonomous modellt választott, annál a régi kód
  nem nyit új Autonomous pozíciót; az Autonomous PAPER pozíciók a külön ledgerben (`MlAutonomousPosition`)
  maradnak, a régi kód nem kezeli őket (PAPER, valódi pénz nincs érintve). Rollback előtt ajánlott a Beállításokban
  „Nincs modell” + „Új belépések szüneteltetése”, és megvárni a nyitott Autonomous pozíciók zárását.
- Ha a `docker-compose.vps.yml`-t módosítottad: `cp "$B/docker-compose.vps.yml" .`
- Adatbázis visszatöltése csak végső esetben, és csak a mentett dumpból, előzetes új mentés után
  (`pg_restore --clean` a teljes adatbázist felülírja – a 3.0 óta gyűjtött adat elveszik).
- `ml/models`, `ml/datasets`: a telepítés nem írja őket; sérülés esetén `tar xzf "$B/ml-models.tgz"`.

## 10. Ismert korlátok a telepítéskor

- Docker image buildet a fejlesztői gépen nem lehetett ellenőrizni (a Docker nem futott); csak `docker compose config`
  validált. Az első VPS build (főleg `ml-trainer`, LightGBM wheel) a valódi ellenőrzés.
- Modell kereskedni csak e-mailben megerősített jóváhagyás (≥ 500 SHADOW döntés, SHADOW_READY minőség) és kézi
  kiválasztás után fog; addig adatgyűjtés fut.
