# Kalbėjimo treniruoklis

Maža naršyklinė programėlė, padedanti II gimnazijos (10) klasės mokiniui pasiruošti lietuvių kalbos
kalbėjimo įskaitai: pristatyti duotą tekstą žodžiu pagal mokytojos 6 punktų planą ir gauti AI grįžtamąjį ryšį.

Kaip tai veikia:

1. **Tekstai** – nufotografuok tekstą (AI jį perskaitys) arba įklijuok ranka.
2. **Pasiruošimas** – 6 plano punktai su užuominomis, sakinių pradžiomis ir savo užrašais.
3. **Kalbėjimas** – laikmatis su tiksline trukme (numatyta 2–3 min.), garso įrašas ir automatinė stenograma.
4. **Vertinimas** – kas pagal planą pasakyta, ko trūksta, kalbos klaidos ir svarbiausias patarimas.
5. **Istorija** – ankstesni bandymai ir jų vertinimai.

## Paleidimas savo kompiuteryje

Nereikia nieko diegti ar kompiliuoti – tai statiniai failai (HTML, CSS, ES moduliai).

```sh
python3 -m http.server 8000
```

Tada naršyklėje atidaryk <http://localhost:8000>. Tiesiog atidaryti `index.html` iš disko (`file://`) neužteks –
ES moduliai ir mikrofonas veikia tik per `http://localhost` arba `https://`.

## GitHub Pages

Visi keliai santykiniai, todėl užtenka saugyklos nustatymuose įjungti „Pages“ (šaltinis – pagrindinė šaka,
šakninis aplankas). Programėlė veiks adresu `https://<vartotojas>.github.io/<saugykla>/`.

## API raktas ir duomenys

- AI funkcijoms (teksto nuskaitymui iš nuotraukų ir vertinimui) reikia API rakto – jį įvesk skiltyje **Nustatymai**.
- Raktas saugomas **tik tavo naršyklės `localStorage`** ir siunčiamas tik AI paslaugai kartu su užklausomis.
  Šis projektas neturi jokio savo serverio. Nenaudok programėlės svetimame ar bendrame įrenginyje su savo raktu.
- Tekstai, užrašai ir bandymai taip pat laikomi tik `localStorage`; garso įrašas lieka atmintyje tik iki puslapio uždarymo.

## Naršyklė

Rekomenduojama **Chrome** (kompiuteryje arba „Android“) – joje veikia lietuvių kalbos atpažinimas.
Kitose naršyklėse laikmatis ir įrašas veikia, bet stenogramą gali tekti įrašyti ranka.

## Talpinimas Hostinger (rekomenduojama)

Su PHP talpinimu API raktas lieka serveryje, o programėlė atrakinama serverio slaptažodžiu.

1. Įkelk visus repo failus į `public_html` (arba jo poaplankį): per hPanel → **Failų tvarkyklę** arba hPanel → **Git**.
2. Serveryje nukopijuok `config.example.php` kaip `config.php` ir įrašyk API raktą (nexos.ai arba Anthropic) bei slaptažodį (bent 8 ženklai).
3. Įsitikink, kad svetainei įjungtas SSL (HTTPS) – be jo neveiks mikrofonas.
4. Atidaryk svetainę telefone per Chrome, prisijunk slaptažodžiu. Su nexos.ai raktu: **Nustatymai → Įkelti modelių sąrašą** ir pasirink modelį.

`config.php` į repo nekeliamas (`.gitignore`), o `.htaccess` neleidžia jo atidaryti per naršyklę.
Be `api.php` (pvz., GitHub Pages) programėlė veikia senuoju būdu – raktas įvedamas nustatymuose.
