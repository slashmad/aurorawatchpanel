import sqlite3
import mysql.connector
import getpass

# --- KONFIGURATION ---
SQLITE_DB = 'magneto.db'  # Sökväg till din gamla SQLite-db

print("== Migrera från SQLite till MariaDB för Aurora Watch ==")
mariadb_host = input("MariaDB host [localhost]: ") or "localhost"
mariadb_port = input("Port [3306]: ") or "3306"
mariadb_user = input("Användarnamn [aurora]: ") or "aurora"
mariadb_pass = getpass.getpass("Lösenord (syns ej): ")
mariadb_db   = input("Databas [aurora]: ") or "aurora"


print("\nÖppnar SQLite...")
sqlite_conn = sqlite3.connect(SQLITE_DB)
sqlite_cur = sqlite_conn.cursor()

print("Kopplar till MariaDB...")
mariadb_conn = mysql.connector.connect(
    host=mariadb_host,
    port=int(mariadb_port),
    user=mariadb_user,
    password=mariadb_pass,
    database=mariadb_db
)
mariadb_cur = mariadb_conn.cursor()

# --- TABELLER ATT MIGRERA ---
tables = {
    "magnetometer": """
        CREATE TABLE IF NOT EXISTS magnetometer (
            station     VARCHAR(10),
            timestamp   DATETIME,
            deflection  FLOAT,
            kirx        FLOAT,
            kiry        FLOAT,
            kirz        FLOAT,
            kirf        FLOAT,
            PRIMARY KEY (station, timestamp)
        )
    """,
    "solarwind": """
        CREATE TABLE IF NOT EXISTS solarwind (
            timestamp DATETIME PRIMARY KEY,
            speed     FLOAT,
            density   FLOAT,
            bt        FLOAT,
            bz        FLOAT,
            `by`        FLOAT
        )
    """,
    "kp_index": """
        CREATE TABLE IF NOT EXISTS kp_index (
            timestamp DATETIME PRIMARY KEY,
            kp        INT
        )
    """
}

for tablename, create_sql in tables.items():
    print(f"Skapar tabell '{tablename}' i MariaDB om den saknas...")
    mariadb_cur.execute(create_sql)
mariadb_conn.commit()

# --- MIGRERING ---
def migrate_table(tablename, columns, placeholders):
    print(f"Migrerar {tablename}...")
    sqlite_cur.execute(f"SELECT {', '.join(columns)} FROM {tablename}")
    rows = sqlite_cur.fetchall()
    if not rows:
        print(f"  (Inga rader i {tablename})")
        return
    mariadb_cur.execute(f"DELETE FROM {tablename}")  # Rensa tabellen först (valfritt)
    batch = 0
    for row in rows:
        mariadb_cur.execute(
            f"INSERT IGNORE INTO {tablename} ({', '.join(columns)}) VALUES ({placeholders})",
            row
        )
        batch += 1
        if batch % 1000 == 0:
            mariadb_conn.commit()
    mariadb_conn.commit()
    print(f"  {batch} rader migrerade.")

# Magnetometer
migrate_table(
    "magnetometer",
    ["station", "timestamp", "deflection", "kirx", "kiry", "kirz", "kirf"],
    "%s, %s, %s, %s, %s, %s, %s"
)
# Solarwind
migrate_table(
    "solarwind",
    ["timestamp", "speed", "density", "bt", "bz", "`by`"],
    "%s, %s, %s, %s, %s, %s"
)
# KP-index
migrate_table(
    "kp_index",
    ["timestamp", "kp"],
    "%s, %s"
)

sqlite_conn.close()
mariadb_cur.close()
mariadb_conn.close()
print("== Migrering klar! Kontrollera din MariaDB så all data kom med. ==")
