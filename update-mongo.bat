@echo off
echo Updating MongoDB URI in .env file...
echo.

cd /d "%~dp0"

if not exist ".env" (
    echo ERROR: .env file not found!
    pause
    exit /b 1
)

REM Create a temporary file with updated MONGO_URI
(
    for /f "usebackq delims=" %%a in (".env") do (
        set "line=%%a"
        setlocal enabledelayedexpansion
        if "!line:~0,9!"=="MONGO_URI" (
            echo MONGO_URI=mongodb+srv://medtechaioffice_db_user:TxDv3t3xTKrLeXjW@chatdata.hf7civz.mongodb.net/linkchat
        ) else (
            echo %%a
        )
        endlocal
    )
) > .env.tmp

move /y .env.tmp .env >nul

echo.
echo ✅ MongoDB URI updated successfully!
echo.
echo New URI: mongodb+srv://medtechaioffice_db_user:***@chatdata.hf7civz.mongodb.net/linkchat
echo.
echo Please restart your backend server for changes to take effect.
echo.
pause


