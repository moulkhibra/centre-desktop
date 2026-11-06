@echo off
title Centre - Diagnostic
cd /d "%~dp0"
if not exist "%~dp0Centre-Installer-et-Lancer.bat" (
  echo ERREUR : Centre-Installer-et-Lancer.bat introuvable dans ce dossier.
  echo Placez les deux fichiers BAT dans le meme dossier que package.json.
  pause
  exit /b 1
)
cmd.exe /k ""%~dp0Centre-Installer-et-Lancer.bat""
