@echo off
setlocal
pushd "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 launch.py --open
goto done
:usepython
python launch.py --open
:done
if errorlevel 1 pause
popd
