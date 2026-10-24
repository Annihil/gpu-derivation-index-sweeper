cmake_minimum_required(VERSION 3.24)
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
  set(CMAKE_CUDA_ARCHITECTURES native CACHE STRING "CUDA architectures; native or e.g. 86, 89, 120")
endif()
project(gpu_derivation_index_sweeper LANGUAGES CXX CUDA)
add_executable(index-scan-gpu cuda/scanner.cu)
set_target_properties(index-scan-gpu PROPERTIES
  CUDA_STANDARD 17 CUDA_STANDARD_REQUIRED YES
  CXX_STANDARD 17 CXX_STANDARD_REQUIRED YES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin")
target_compile_options(index-scan-gpu PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:-O3>)
