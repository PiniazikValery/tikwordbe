# GPU Setup Guide for Whisper Transcription

This guide will help you set up GPU acceleration for Whisper transcription, which can speed up processing by **10-50x** compared to CPU.

## Prerequisites

### 1. NVIDIA GPU
- You need a physical NVIDIA GPU (GTX 1060 or newer recommended)
- Check your GPU: `nvidia-smi` (should show your GPU info)

### 2. NVIDIA Docker Runtime

#### Windows (with WSL2):
1. Install WSL2 and Ubuntu
2. Install NVIDIA drivers for Windows
3. Install Docker Desktop for Windows
4. Install nvidia-docker2 in WSL2:
```bash
# In WSL2 terminal
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list

sudo apt-get update
sudo apt-get install -y nvidia-docker2
sudo systemctl restart docker
```

#### Linux:
```bash
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list

sudo apt-get update
sudo apt-get install -y nvidia-docker2
sudo systemctl restart docker
```

#### macOS:
Sorry, NVIDIA GPU support is not available on macOS. You'll need to use CPU mode.

### 3. Verify GPU Docker Support

Run this test:
```bash
docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi
```

You should see your GPU information. If this works, you're ready!

## Setup Steps

### 1. Build the GPU Docker Image

```bash
docker build -f Dockerfile.whisper.gpu -t tickword-whisper-gpu:latest .
```

This will take several minutes as it downloads CUDA and PyTorch with GPU support.

### 2. Enable GPU in Your Application

Edit your `.env` file (copy from `.env.example` if needed):
```env
USE_GPU=true
```

### 3. Test It!

Start your server and make a request. You should see:
- `(GPU mode)` in the logs instead of `(CPU mode)`
- **Much faster** transcription times
- **No more FP16/FP32 warning**

## Performance Comparison

**CPU (FP32):**
- ~30-60 seconds per 30-second chunk
- Uses all CPU cores
- Shows warning: "FP16 is not supported on CPU; using FP32 instead"

**GPU (FP16):**
- ~2-5 seconds per 30-second chunk
- Uses GPU VRAM (usually 2-4 GB)
- No warnings, clean output
- **10-50x faster** depending on your GPU

## Troubleshooting

### "could not select device driver" error
- Make sure `nvidia-docker2` is installed
- Restart Docker daemon: `sudo systemctl restart docker`
- Verify with: `docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi`

### "Unknown runtime specified nvidia" error
- NVIDIA Docker runtime not installed properly
- Re-run the installation steps above

### Out of memory errors
- Your GPU might not have enough VRAM (need at least 2GB)
- Try using a smaller Whisper model (already using 'base', which is smallest useful model)
- Or stick with CPU mode

### Still seeing FP32 warning with GPU enabled
- The GPU Docker image might not be built correctly
- Rebuild with: `docker build --no-cache -f Dockerfile.whisper.gpu -t tickword-whisper-gpu:latest .`
- Make sure USE_GPU=true in your .env file

## Switching Back to CPU Mode

If you encounter issues or don't have an NVIDIA GPU:

1. Edit `.env`:
   ```env
   USE_GPU=false
   ```

2. Make sure the CPU image is built:
   ```bash
   docker build -f Dockerfile.whisper -t tickword-whisper:latest .
   ```

The application will automatically fall back to CPU mode.
