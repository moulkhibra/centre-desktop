@echo off
setlocal EnableExtensions
title Centre - Installation et lancement

echo.
echo ============================================
echo       CENTRE - Installation et lancement
echo ============================================
echo.

REM Always work from the folder containing this BAT file.
cd /d "%~dp0"

if not exist "package.json" (
    echo ERREUR : package.json introuvable.
    echo Placez ce fichier BAT dans le dossier principal du projet Centre.
    echo.
    pause
    exit /b 1
)

REM Check Node.js and npm.
where node >nul 2>nul
if errorlevel 1 (
    echo ERREUR : Node.js n'est pas installe ou absent du PATH.
    echo Installez Node.js 20 LTS x64, puis relancez ce fichier.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo ERREUR : npm est introuvable.
    echo Reinstallez Node.js 20 LTS x64, puis relancez ce fichier.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%V
echo Node.js :
node -v
echo npm :
npm -v
echo.

if not defined NODE_MAJOR (
    echo ERREUR : impossible de verifier la version de Node.js.
    pause
    exit /b 1
)
if %NODE_MAJOR% LSS 18 (
    echo ERREUR : Node.js 18 ou plus recent est requis.
    echo Utilisez de preference Node.js 20 LTS x64.
    echo.
    pause
    exit /b 1
)

REM Safety: this application stores data in the current Windows user's Documents.
for /f "usebackq delims=" %%D in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[Environment]::GetFolderPath('MyDocuments')"`) do set "DOCS=%%D"

if not defined DOCS (
    echo ERREUR : impossible de determiner le dossier Documents.
    pause
    exit /b 1
)

echo Dossier Documents detecte :
echo "%DOCS%"
echo.

echo "%DOCS%" | findstr /i "OneDrive" >nul
if not errorlevel 1 (
    echo ATTENTION : Documents semble etre synchronise avec OneDrive.
    echo Pour ce test, utilisez un compte Windows local de test avec Documents local.
    echo.
    pause
    exit /b 1
)

if exist "%DOCS%\CentreData" (
    echo ARRET PAR SECURITE :
    echo Le dossier "%DOCS%\CentreData" existe deja.
    echo Il peut contenir des donnees existantes.
    echo N'effacez rien. Utilisez un compte Windows local de test distinct.
    echo.
    pause
    exit /b 1
)

echo IMPORTANT :
echo - Ce lancement va installer les dependances du projet dans ce dossier.
echo - L'application pourra creer Documents\CentreData pour ses donnees de test.
echo - N'utilisez qu'un compte Windows local de test, sans donnees reelles.
echo.
choice /c ON /n /m "Etes-vous bien dans un compte Windows de test jetable ? [O/N] : "
if errorlevel 2 (
    echo.
    echo Operation annulee. Aucun changement effectue.
    pause
    exit /b 0
)

echo.
echo [1/2] Installation des dependances...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo ERREUR pendant npm install. L'application ne sera pas lancee.
    pause
    exit /b 1
)

echo.
echo [2/2] Lancement de Centre...
echo La fenetre de l'application va s'ouvrir.
echo Pour arreter, fermez la fenetre Centre.
echo.
call npm start
set "APP_EXIT=%ERRORLEVEL%"

echo.
if not "%APP_EXIT%"=="0" (
    echo L'application s'est terminee avec le code %APP_EXIT%.
) else (
    echo L'application est fermee.
)
echo.
pause
exit /b %APP_EXIT%
